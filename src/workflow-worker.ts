import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { AgentUsage } from "./agent.js";
import { WorkflowError, type WorkflowErrorCode } from "./errors.js";
import { createSrtSandboxAdapter, type SandboxAdapter } from "./sandbox.js";
import type { JournalEntry, WorkflowResumeState } from "./workflow.js";
import { runWorkflowInProcess, type WorkflowRunOptions, type WorkflowRunResult } from "./workflow.js";

interface WorkerRunRequest {
  type: "run";
  script: string;
  args?: unknown;
  cwd: string;
  concurrency?: number;
  tokenBudget?: number | null;
  maxAgents?: number;
  agentTimeoutMs?: number | null;
  agentRetries?: number;
  persistLogs?: boolean;
  runId?: string;
  resumeJournal?: Array<[string, JournalEntry]>;
  resumeFromRunId?: string;
  initialTokenUsage?: AgentUsage;
  resume?: WorkflowResumeState;
  savedWorkflows?: Record<string, string>;
  confirm?: boolean;
}

interface WorkerAgentRequest {
  type: "agent";
  id: number;
  prompt: string;
  options: Record<string, unknown>;
}

interface WorkerAbortRequest {
  type: "abort";
}

interface WorkerAgentAbortRequest {
  type: "agentAbort";
  id: number;
}

interface WorkerAgentUpdate {
  type: "agentUpdate";
  id: number;
  update: "model" | "usageProgress" | "history";
  value: unknown;
}

interface WorkerCheckpointRequest {
  type: "checkpoint";
  id: number;
  promptText: string;
  options: unknown;
}

interface WorkerCheckpointReply {
  type: "checkpointReply";
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

type WorkerRequest = WorkerRunRequest | WorkerAgentRequest | WorkerAbortRequest | WorkerAgentAbortRequest;
type WorkerInbound =
  | WorkerRequest
  | WorkerAgentUpdate
  | WorkerCheckpointReply
  | Extract<WorkerReply, { type: "agentReply" }>;

const MAX_PROTOCOL_LINE_LENGTH = 256 * 1024;
const DEFAULT_WORKER_TIMEOUT_MS = 5 * 60 * 1000;

function preloadSavedWorkflows(
  script: string,
  loader: WorkflowRunOptions["loadSavedWorkflow"],
): Record<string, string> {
  if (!loader) return {};
  const saved: Record<string, string> = {};
  const names = script.matchAll(/\bworkflow\s*\(\s*(['"])([^'"\\]*(?:\\.[^'"\\]*)*)\1/g);
  for (const match of names) {
    const name = match[2];
    const child = loader(name);
    if (child !== undefined) saved[name] = child;
  }
  return saved;
}

type WorkerEvent =
  | { type: "event"; event: "log"; message: string }
  | { type: "event"; event: "phase"; title: string }
  | { type: "event"; event: "agentStart"; value: unknown }
  | { type: "event"; event: "agentModel"; value: unknown }
  | { type: "event"; event: "agentUsage"; value: unknown }
  | { type: "event"; event: "tokenUsage"; value: unknown }
  | { type: "event"; event: "agentHistory"; value: unknown }
  | { type: "event"; event: "agentJournal"; value: unknown }
  | { type: "event"; event: "agentEnd"; value: unknown };

type WorkerReply =
  | {
      type: "agentReply";
      id: number;
      ok: true;
      result: unknown;
      model?: string;
      usage?: AgentUsage;
    }
  | {
      type: "agentReply";
      id: number;
      ok: false;
      error: string;
      model?: string;
      errorCode?: string;
      recoverable?: boolean;
      fatal?: boolean;
      usage?: AgentUsage;
    }
  | { type: "result"; ok: true; result: WorkflowRunResult }
  | {
      type: "result";
      ok: false;
      error: string;
      errorCode?: string;
      recoverable?: boolean;
    };

export interface SandboxedWorkflowOptions extends WorkflowRunOptions {
  sandboxAdapter?: SandboxAdapter;
}

export async function runSandboxedWorkflow<T = unknown>(
  script: string,
  options: SandboxedWorkflowOptions = {},
): Promise<WorkflowRunResult<T>> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const workerTempDir = mkdtempSync(join(tmpdir(), "pi-workflow-worker-"));
  const worker = resolveWorkerCommand(workerTempDir);
  const adapter =
    options.sandboxAdapter ??
    createSrtSandboxAdapter({
      workspace: cwd,
      allowWrite: [workerTempDir],
      denyRead: [join(cwd, ".pi")],
      denyWrite: [join(cwd, ".pi")],
      allowedDomains: [],
      allowLocalBinding: worker.requiresLocalBinding,
    });
  const availability = adapter.check();
  if (availability.status === "unavailable") {
    await adapter.dispose();
    rmSync(workerTempDir, { recursive: true, force: true });
    throw new Error(`workflow sandbox unavailable: ${availability.reason}`);
  }

  const started = await adapter.start(worker.command, `workflow-${Date.now()}`);
  if ("unavailableReason" in started) {
    await adapter.dispose();
    rmSync(workerTempDir, { recursive: true, force: true });
    throw new Error(`workflow sandbox unavailable: ${started.unavailableReason}`);
  }

  const session = started.session;
  const runner = options.agent ?? new (await import("./agent.js")).WorkflowAgent(options);
  const controllers = new Set<AbortController>();
  const agentControllers = new Map<number, AbortController>();
  let settled = false;
  let readLoop: Promise<void>;
  let workerTimeout: ReturnType<typeof setTimeout> | undefined;
  let resolveResult!: (result: WorkflowRunResult<T>) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<WorkflowRunResult<T>>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const send = (message: WorkerRequest | WorkerReply | WorkerEvent | WorkerAgentUpdate | WorkerCheckpointReply) => {
    session.write(JSON.stringify(message));
  };

  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    rejectResult(error instanceof Error ? error : new Error(String(error)));
  };

  const handleAgent = async (request: WorkerAgentRequest) => {
    const controller = new AbortController();
    controllers.add(controller);
    agentControllers.set(request.id, controller);
    const removeAbort = linkAbort(options.signal, controller);
    let model: string | undefined;
    let usage: AgentUsage | undefined;
    const timeoutMs =
      typeof request.options.timeoutMs === "number" && request.options.timeoutMs > 0
        ? request.options.timeoutMs
        : undefined;
    const timeout = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs);
    try {
      const value = await runner.run(request.prompt, {
        ...(request.options as any),
        signal: controller.signal,
        onModelResolved: (resolved: string) => {
          model = resolved;
          send({ type: "agentUpdate", id: request.id, update: "model", value: resolved });
        },
        onUsageProgress: (value: AgentUsage) => {
          send({ type: "agentUpdate", id: request.id, update: "usageProgress", value });
        },
        onHistory: (value: unknown) => {
          send({ type: "agentUpdate", id: request.id, update: "history", value });
        },
        onUsage: (value: AgentUsage) => {
          usage = value;
        },
      } as any);
      send({ type: "agentReply", id: request.id, ok: true, result: value, model, usage });
    } catch (error) {
      send({
        type: "agentReply",
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        errorCode:
          typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : undefined,
        recoverable:
          typeof (error as { recoverable?: unknown })?.recoverable === "boolean"
            ? (error as { recoverable: boolean }).recoverable
            : undefined,
        fatal: (error as { fatal?: unknown })?.fatal === true,
        usage,
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      removeAbort();
      controllers.delete(controller);
      agentControllers.delete(request.id);
    }
  };

  const handleMessage = async (
    message: WorkerEvent | WorkerReply | WorkerAgentRequest | WorkerAgentAbortRequest | WorkerCheckpointRequest,
  ) => {
    if (message.type === "checkpoint") {
      try {
        const value = options.confirm ? await options.confirm(message.promptText, message.options as never) : undefined;
        send({ type: "checkpointReply", id: message.id, ok: true, value });
      } catch (error) {
        send({
          type: "checkpointReply",
          id: message.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (message.type === "agent") {
      void handleAgent(message);
      return;
    }
    if (message.type === "agentAbort") {
      agentControllers.get(message.id)?.abort(new Error("workflow agent aborted"));
      return;
    }
    if (message.type === "event") {
      if (message.event === "log") options.onLog?.(message.message);
      else if (message.event === "phase") options.onPhase?.(message.title);
      else if (message.event === "agentStart") options.onAgentStart?.(message.value as any);
      else if (message.event === "agentModel") options.onAgentModel?.(message.value as any);
      else if (message.event === "agentUsage") options.onAgentUsage?.(message.value as any);
      else if (message.event === "tokenUsage") options.onTokenUsage?.(message.value as any);
      else if (message.event === "agentHistory") options.onAgentHistory?.(message.value as any);
      else if (message.event === "agentJournal") options.onAgentJournal?.(message.value as any);
      else if (message.event === "agentEnd") options.onAgentEnd?.(message.value as any);
      return;
    }
    if (message.type === "result") {
      if (message.ok) {
        settled = true;
        resolveResult(message.result as WorkflowRunResult<T>);
      } else {
        fail(
          message.errorCode
            ? new WorkflowError(message.error, message.errorCode as WorkflowErrorCode, {
                recoverable: message.recoverable,
              })
            : new Error(message.error),
        );
      }
    }
  };

  readLoop = (async () => {
    try {
      for (;;) {
        const line = await session.readLine();
        let message: WorkerEvent | WorkerReply | WorkerAgentRequest | WorkerAgentAbortRequest | WorkerCheckpointRequest;
        if (line.length > MAX_PROTOCOL_LINE_LENGTH) {
          throw new Error(`workflow sandbox protocol line exceeds ${MAX_PROTOCOL_LINE_LENGTH} bytes`);
        }
        try {
          message = parseWorkerOutput(JSON.parse(line));
        } catch (error) {
          throw new Error(
            `workflow sandbox returned invalid protocol data: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await handleMessage(message);
        if (settled) return;
      }
    } catch (error) {
      fail(error);
    }
  })();

  const onAbort = () => {
    for (const controller of controllers) controller.abort(options.signal?.reason);
    try {
      send({ type: "abort" });
    } catch {
      // The worker may already have exited.
    }
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const timeoutMs = options.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("workerTimeoutMs must be a positive number");
    workerTimeout = setTimeout(() => {
      fail(new Error(`workflow sandbox timed out after ${timeoutMs}ms`));
      session.kill();
    }, timeoutMs);
    send({
      type: "run",
      script,
      ...(options.args !== undefined ? { args: options.args } : {}),
      cwd,
      ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
      ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
      ...(options.maxAgents !== undefined ? { maxAgents: options.maxAgents } : {}),
      ...(options.agentTimeoutMs !== undefined ? { agentTimeoutMs: options.agentTimeoutMs } : {}),
      ...(options.agentRetries !== undefined ? { agentRetries: options.agentRetries } : {}),
      ...(options.persistLogs !== undefined ? { persistLogs: options.persistLogs } : {}),
      ...(options.runId !== undefined ? { runId: options.runId } : {}),
      ...(options.resumeJournal ? { resumeJournal: [...options.resumeJournal.entries()] } : {}),
      ...(options.resumeFromRunId !== undefined ? { resumeFromRunId: options.resumeFromRunId } : {}),
      ...(options.initialTokenUsage !== undefined ? { initialTokenUsage: options.initialTokenUsage } : {}),
      ...(options.resume !== undefined ? { resume: options.resume } : {}),
      ...(options.loadSavedWorkflow
        ? { savedWorkflows: preloadSavedWorkflows(script, options.loadSavedWorkflow) }
        : {}),
      ...(options.confirm ? { confirm: true } : {}),
    });
    return await result;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (workerTimeout) clearTimeout(workerTimeout);
    for (const controller of controllers) controller.abort();
    session.kill();
    await Promise.race([readLoop, session.exited]);
    await adapter.dispose();
    rmSync(workerTempDir, { recursive: true, force: true });
  }
}

async function runWorkerProcess(): Promise<void> {
  const input = createInterface({ input: process.stdin });
  let controller: AbortController | undefined;
  let agentId = 1;
  const pending = new Map<number, { resolve: (reply: WorkerReply) => void; options: Record<string, unknown> }>();
  const pendingCheckpoints = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  const send = (
    message:
      | WorkerEvent
      | WorkerReply
      | WorkerAgentRequest
      | WorkerAgentAbortRequest
      | WorkerAgentUpdate
      | WorkerCheckpointRequest,
  ) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  const proxy = {
    async confirm(promptText: string, options: unknown) {
      const id = agentId++;
      const reply = new Promise<unknown>((resolve, reject) => {
        pendingCheckpoints.set(id, { resolve, reject });
      });
      send({ type: "checkpoint", id, promptText, options: jsonSafe(options) });
      return await reply;
    },
    async run(prompt: string, options: Record<string, unknown> = {}) {
      const id = agentId++;
      let resolveReply!: (reply: WorkerReply) => void;
      const reply = new Promise<WorkerReply>((resolve) => {
        resolveReply = resolve;
        pending.set(id, { resolve: resolveReply, options });
      });
      const onAbort = () => send({ type: "agentAbort", id });
      const signal = options.signal as AbortSignal | undefined;
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      send({ type: "agent", id, prompt, options: jsonSafe(options) });
      const message = await reply;
      signal?.removeEventListener("abort", onAbort);
      if (message.type !== "agentReply") throw new Error("workflow worker protocol mismatch");
      const callbacks = options as any;
      if (message.model !== undefined) callbacks.onModelResolved?.(message.model);
      if (message.usage) callbacks.onUsage?.(message.usage);
      if (!message.ok) {
        if (message.errorCode) {
          const error = new WorkflowError(message.error, message.errorCode as WorkflowErrorCode, {
            recoverable: message.recoverable,
          });
          (error as WorkflowError & { fatal?: boolean }).fatal = message.fatal;
          throw error;
        }
        const error = new Error(message.error) as Error & { fatal?: boolean };
        error.fatal = message.fatal;
        throw error;
      }
      return message.result;
    },
  };

  let running = false;
  const executeRun = async (message: WorkerRunRequest) => {
    controller = new AbortController();
    try {
      const run = await runWorkflowInProcess(message.script, {
        sandbox: "none",
        args: message.args,
        cwd: message.cwd,
        loadSavedWorkflow: message.savedWorkflows ? (name: string) => message.savedWorkflows?.[name] : undefined,
        confirm: message.confirm ? proxy.confirm : undefined,
        concurrency: message.concurrency,
        tokenBudget: message.tokenBudget,
        resume: message.resume,
        runId: message.runId,
        maxAgents: message.maxAgents,
        agentTimeoutMs: message.agentTimeoutMs,
        agentRetries: message.agentRetries,
        persistLogs: message.persistLogs,
        resumeJournal: message.resumeJournal ? new Map(message.resumeJournal) : undefined,
        resumeFromRunId: message.resumeFromRunId,
        initialTokenUsage: message.initialTokenUsage,
        signal: controller.signal,
        agent: proxy as any,
        onLog: (value) => send({ type: "event", event: "log", message: value }),
        onPhase: (value) => send({ type: "event", event: "phase", title: value }),
        onAgentStart: (value) => send({ type: "event", event: "agentStart", value }),
        onAgentModel: (value) => send({ type: "event", event: "agentModel", value }),
        onAgentUsage: (value) => send({ type: "event", event: "agentUsage", value }),
        onTokenUsage: (value) => send({ type: "event", event: "tokenUsage", value }),
        onAgentHistory: (value) => send({ type: "event", event: "agentHistory", value }),
        onAgentJournal: (value) => send({ type: "event", event: "agentJournal", value }),
        onAgentEnd: (value) => send({ type: "event", event: "agentEnd", value }),
      });
      send({ type: "result", ok: true, result: run });
    } catch (error) {
      send({
        type: "result",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        errorCode:
          typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : undefined,
        recoverable:
          typeof (error as { recoverable?: unknown })?.recoverable === "boolean"
            ? (error as { recoverable: boolean }).recoverable
            : undefined,
      });
    } finally {
      running = false;
    }
  };

  for await (const line of input) {
    let message: WorkerInbound;
    try {
      if (line.length > MAX_PROTOCOL_LINE_LENGTH) throw new Error("protocol line too long");
      message = parseWorkerInbound(JSON.parse(line));
    } catch {
      send({ type: "result", ok: false, error: "workflow worker received invalid protocol data" });
      return;
    }
    if (message.type === "agentReply") {
      pending.get(message.id)?.resolve(message);
      pending.delete(message.id);
      continue;
    }
    if (message.type === "checkpointReply") {
      const checkpoint = pendingCheckpoints.get(message.id);
      pendingCheckpoints.delete(message.id);
      if (checkpoint) {
        if (message.ok) checkpoint.resolve(message.value);
        else checkpoint.reject(new Error(message.error ?? "workflow checkpoint failed"));
      }
      continue;
    }
    if (message.type === "agentUpdate") {
      const request = pending.get(message.id);
      if (request) {
        const callbacks = request.options as {
          onModelResolved?: (value: unknown) => void;
          onUsageProgress?: (value: unknown) => void;
          onHistory?: (value: unknown) => void;
        };
        if (message.update === "model") callbacks.onModelResolved?.(message.value);
        else if (message.update === "usageProgress") callbacks.onUsageProgress?.(message.value);
        else callbacks.onHistory?.(message.value);
      }
      continue;
    }
    if (message.type === "abort") {
      controller?.abort(new Error("workflow aborted"));
      continue;
    }
    if (message.type !== "run") continue;
    if (running) {
      send({ type: "result", ok: false, error: "workflow worker already has a run" });
      continue;
    }
    running = true;
    void executeRun(message);
  }
}

function parseWorkerInbound(value: unknown): WorkerInbound {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("missing message type");
  if (value.type === "abort") return { type: "abort" };
  if (value.type === "agentAbort") {
    if (!Number.isInteger(value.id)) throw new Error("invalid agent abort");
    // SAFETY: discriminant and id were validated immediately above.
    return value as unknown as WorkerAgentAbortRequest;
  }
  if (value.type === "run") {
    if (typeof value.script !== "string" || typeof value.cwd !== "string") throw new Error("invalid run message");
    // SAFETY: required run fields were validated immediately above.
    return value as unknown as WorkerRunRequest;
  }
  if (value.type === "agentReply") {
    if (!Number.isInteger(value.id) || typeof value.ok !== "boolean") throw new Error("invalid agent reply");
    if (!value.ok && typeof value.error !== "string") throw new Error("invalid agent reply error");
    // SAFETY: reply discriminant, id, and error shape were validated above.
    return value as unknown as Extract<WorkerReply, { type: "agentReply" }>;
  }
  if (value.type === "checkpointReply") {
    if (!Number.isInteger(value.id) || typeof value.ok !== "boolean") throw new Error("invalid checkpoint reply");
    if (!value.ok && typeof value.error !== "string") throw new Error("invalid checkpoint reply error");
    // SAFETY: checkpoint reply discriminant and required fields were validated above.
    return value as unknown as WorkerCheckpointReply;
  }
  if (value.type === "agentUpdate") {
    if (!Number.isInteger(value.id) || !["model", "usageProgress", "history"].includes(String(value.update))) {
      throw new Error("invalid agent update");
    }
    // SAFETY: update discriminant and id were validated immediately above.
    return value as unknown as WorkerAgentUpdate;
  }
  throw new Error("unexpected worker message type");
}

function parseWorkerOutput(
  value: unknown,
): WorkerEvent | WorkerReply | WorkerAgentRequest | WorkerAgentAbortRequest | WorkerCheckpointRequest {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("missing message type");
  if (value.type === "agent") {
    if (!Number.isInteger(value.id) || typeof value.prompt !== "string" || !isRecord(value.options)) {
      throw new Error("invalid agent request");
    }
    // SAFETY: agent discriminant, id, prompt, and options were validated above.
    return value as unknown as WorkerAgentRequest;
  }
  if (value.type === "agentAbort") {
    if (!Number.isInteger(value.id)) throw new Error("invalid agent abort");
    // SAFETY: agent-abort discriminant and id were validated immediately above.
    return value as unknown as WorkerAgentAbortRequest;
  }
  if (value.type === "checkpoint") {
    if (!Number.isInteger(value.id) || typeof value.promptText !== "string") {
      throw new Error("invalid checkpoint request");
    }
    // SAFETY: checkpoint discriminant, id, and prompt were validated above.
    return value as unknown as WorkerCheckpointRequest;
  }
  if (value.type === "event") {
    if (value.event === "log" && typeof value.message !== "string") throw new Error("invalid log event");
    if (value.event === "phase" && typeof value.title !== "string") throw new Error("invalid phase event");
    if (
      ["agentStart", "agentModel", "agentUsage", "tokenUsage", "agentHistory", "agentJournal", "agentEnd"].includes(
        String(value.event),
      ) &&
      !("value" in value)
    ) {
      throw new Error("invalid agent event");
    }
    if (
      ![
        "log",
        "phase",
        "agentStart",
        "agentModel",
        "agentUsage",
        "tokenUsage",
        "agentHistory",
        "agentJournal",
        "agentEnd",
      ].includes(String(value.event))
    ) {
      throw new Error("unknown event");
    }
    // SAFETY: event discriminant and all event-specific fields were validated above.
    return value as unknown as WorkerEvent;
  }
  if (value.type === "result") {
    if (typeof value.ok !== "boolean") throw new Error("invalid result");
    if (!value.ok && typeof value.error !== "string") throw new Error("invalid result error");
    // SAFETY: result discriminant and error shape were validated above.
    return value as unknown as Extract<WorkerReply, { type: "result" }>;
  }
  throw new Error("unexpected sandbox message type");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveWorkerCommand(workerTempDir: string): { command: string; requiresLocalBinding: boolean } {
  const source = fileURLToPath(new URL("./workflow-worker.ts", import.meta.url));
  const compiledCandidates = [
    source.replace(/\.ts$/, ".js"),
    fileURLToPath(new URL("../dist/workflow-worker.js", import.meta.url)),
  ];
  const compiled = compiledCandidates.find((candidate) => existsSync(candidate));
  if (compiled) {
    return {
      command: `PI_WORKFLOW_WORKER=1 ${shellQuote(process.execPath)} ${shellQuote(compiled)}`,
      requiresLocalBinding: false,
    };
  }
  const require = createRequire(import.meta.url);
  const tsxLoader = require.resolve("tsx/esm");
  return {
    command: `TMPDIR=${shellQuote(workerTempDir)} PI_WORKFLOW_WORKER=1 ${shellQuote(process.execPath)} --import ${shellQuote(tsxLoader)} ${shellQuote(source)}`,
    requiresLocalBinding: false,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function jsonSafe(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(JSON.stringify(value ?? {}));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function linkAbort(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (!parent) return () => {};
  if (parent.aborted) child.abort(parent.reason);
  const onAbort = () => child.abort(parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
}

if (process.env.PI_WORKFLOW_WORKER === "1") {
  void runWorkerProcess();
}
