import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

export type SandboxAvailability = { status: "ready" } | { status: "unavailable"; reason: string };

export interface SandboxPolicy {
  workspace: string;
  allowWrite?: readonly string[];
  denyRead?: readonly string[];
  denyWrite?: readonly string[];
  allowedDomains?: readonly string[];
  deniedDomains?: readonly string[];
  allowLocalBinding?: boolean;
}

export interface SandboxSession {
  write(line: string): void;
  readLine(): Promise<string>;
  exited: Promise<number | null>;
  kill(): void;
}

export interface SandboxAdapter {
  check(): SandboxAvailability;
  start(command: string, invocationId: string): Promise<{ session: SandboxSession } | { unavailableReason: string }>;
  dispose(): Promise<void>;
}

export interface SrtAdapterOptions {
  srtBin?: string;
  tempDir?: string;
}

export function createSrtSandboxAdapter(policy: SandboxPolicy, options: SrtAdapterOptions = {}): SandboxAdapter {
  const srtBin = options.srtBin ?? resolveSrtBin();
  const tempDir = options.tempDir ?? mkdtempSync(join(tmpdir(), "pi-workflow-srt-"));
  let disposed = false;

  const check = (): SandboxAvailability => {
    if (disposed) return { status: "unavailable", reason: "sandbox adapter disposed" };
    if (!isExecutableAvailable(srtBin)) {
      return {
        status: "unavailable",
        reason: `srt binary not found: ${srtBin} (install @anthropic-ai/sandbox-runtime)`,
      };
    }
    return { status: "ready" };
  };

  return {
    check,
    async start(command, invocationId) {
      const availability = check();
      if (availability.status === "unavailable") return { unavailableReason: availability.reason };
      const settingsPath = join(tempDir, `${safeId(invocationId)}.json`);
      writeFileSync(settingsPath, JSON.stringify(toSrtSettings(policy), null, 2));
      try {
        return { session: startSession(srtBin, settingsPath, command) };
      } catch (error) {
        rmSync(settingsPath, { force: true });
        return { unavailableReason: error instanceof Error ? error.message : String(error) };
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

export function toSrtSettings(policy: SandboxPolicy) {
  return {
    filesystem: {
      allowWrite: [policy.workspace, ...(policy.allowWrite ?? [])],
      denyRead: policy.denyRead ?? [],
      denyWrite: policy.denyWrite ?? [],
    },
    network: {
      allowedDomains: policy.allowedDomains ?? [],
      deniedDomains: policy.deniedDomains ?? [],
      allowLocalBinding: policy.allowLocalBinding ?? false,
    },
  };
}

function resolveSrtBin(): string {
  if (isOnPath("srt")) return "srt";
  try {
    const require = createRequire(import.meta.url);
    const packageJson = require.resolve("@anthropic-ai/sandbox-runtime/package.json") as string;
    const packageInfo = JSON.parse(readFileSync(packageJson, "utf8")) as { bin?: Record<string, string> };
    const relativeBin = packageInfo.bin?.srt;
    if (relativeBin) {
      const binary = join(dirname(packageJson), relativeBin);
      if (existsSync(binary)) return binary;
    }
  } catch {
    // Availability is reported by check() with an actionable error.
  }
  return "srt";
}

function isExecutableAvailable(binary: string): boolean {
  return binary.includes("/") ? existsSync(binary) : isOnPath(binary);
}

function isOnPath(binary: string): boolean {
  try {
    return spawnSync("which", [binary], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "workflow";
}

function startSession(binary: string, settingsPath: string, command: string): SandboxSession {
  const child = spawn(binary, ["--settings", settingsPath, "-c", command], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const pending: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  const queued: string[] = [];
  let closed = false;
  let stderr = "";

  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  lines.on("line", (line) => {
    const waiter = pending.shift();
    if (waiter) waiter.resolve(line);
    else queued.push(line);
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("close", (code) => {
      closed = true;
      const detail = stderr.trim();
      const error = new Error(detail ? `sandbox process exited: ${detail}` : "sandbox process exited");
      for (const waiter of pending.splice(0)) waiter.reject(error);
      resolve(code);
    });
    child.once("error", (error) => {
      closed = true;
      for (const waiter of pending.splice(0)) waiter.reject(error);
      resolve(null);
    });
  });

  return {
    write(line) {
      if (closed || !child.stdin.writable) throw new Error("sandbox process is not writable");
      child.stdin.write(`${line}\n`);
    },
    readLine() {
      if (queued.length > 0) return Promise.resolve(queued.shift() as string);
      if (closed) return Promise.reject(new Error("sandbox process has exited"));
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    exited,
    kill() {
      if (!closed) child.kill("SIGTERM");
    },
  };
}
