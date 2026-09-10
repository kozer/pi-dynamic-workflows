import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSrtSandboxAdapter, type SandboxAdapter, toSrtSettings } from "../src/sandbox.js";
import { runWorkflow } from "../src/workflow.js";

test("SRT policy allows the workspace and denies the harness state", () => {
  assert.deepEqual(
    toSrtSettings({
      workspace: "/workspace",
      allowWrite: ["/tmp/worker"],
      denyRead: ["/workspace/.pi"],
      denyWrite: ["/workspace/.pi"],
      allowedDomains: [],
    }),
    {
      filesystem: {
        allowWrite: ["/workspace", "/tmp/worker"],
        denyRead: ["/workspace/.pi"],
        denyWrite: ["/workspace/.pi"],
      },
      network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: false },
    },
  );
});

test("the default workflow path runs through SRT and bridges agents", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "workflow-srt-test-"));
  const result = await runWorkflow(
    `export const meta = { name: "srt_test", description: "worker" }\nconst value = await agent("ping")\nreturn { value }`,
    {
      cwd,
      sandbox: "srt",
      agent: {
        async run(prompt: string) {
          return `reply:${prompt}`;
        },
      },
    },
  );
  assert.deepEqual(result.result, { value: "reply:ping" });
  assert.equal(result.agentCount, 1);
});

test("malformed worker protocol fails closed and cleans up", async () => {
  let killed = false;
  const adapter: SandboxAdapter = {
    check: () => ({ status: "ready" }),
    start: async () => ({
      session: {
        write: () => {},
        readLine: async () => "{}",
        exited: Promise.resolve(0),
        kill: () => {
          killed = true;
        },
      },
    }),
    dispose: async () => {},
  };
  await assert.rejects(
    runWorkflow("export const meta = { name: 'bad', description: 'bad' }\nreturn await agent('x')", {
      sandboxAdapter: adapter,
    }),
    /invalid protocol data/,
  );
  assert.equal(killed, true);
});

test("a stuck worker is terminated by the sandbox timeout", async () => {
  let killed = false;
  let exit!: () => void;
  const adapter: SandboxAdapter = {
    check: () => ({ status: "ready" }),
    start: async () => ({
      session: {
        write: () => {},
        readLine: () => new Promise<string>(() => {}),
        exited: new Promise((resolve) => {
          exit = () => resolve(0);
        }),
        kill: () => {
          killed = true;
          exit();
        },
      },
    }),
    dispose: async () => {},
  };
  await assert.rejects(
    runWorkflow("export const meta = { name: 'stuck', description: 'stuck' }\nreturn await agent('x')", {
      sandboxAdapter: adapter,
      workerTimeoutMs: 10,
    }),
    /timed out after 10ms/,
  );
  assert.equal(killed, true);
});

test("missing SRT fails closed before a worker starts", async () => {
  const adapter = createSrtSandboxAdapter({ workspace: "/workspace" }, { srtBin: "/definitely/missing/srt" });
  assert.deepEqual(adapter.check(), {
    status: "unavailable",
    reason: "srt binary not found: /definitely/missing/srt (install @anthropic-ai/sandbox-runtime)",
  });
  assert.deepEqual(await adapter.start("ignored", "test"), {
    unavailableReason: "srt binary not found: /definitely/missing/srt (install @anthropic-ai/sandbox-runtime)",
  });
  await adapter.dispose();
});
