import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSubagentTool, registerSubagentCommand, runStandaloneAgent } from "../src/subagent-tool.js";

function fakeManager(cwd: string, seen: { prompt?: string; options?: Record<string, unknown> }) {
  return {
    getCwd: () => cwd,
    async runAgent(prompt: string, options: Record<string, unknown>) {
      seen.prompt = prompt;
      seen.options = options;
      return "standalone result";
    },
  };
}

test("runStandaloneAgent applies a named agent definition without a workflow", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-subagent-"));
  try {
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "reviewer.md"),
      `---\nname: reviewer\nmodel: provider/reviewer\ntools: read, grep\ndisallowedTools: edit\n---\nBe skeptical and concise.`,
    );
    const seen: { prompt?: string; options?: Record<string, unknown> } = {};
    const result = await runStandaloneAgent(fakeManager(cwd, seen), {
      prompt: "Inspect this change.",
      agentType: "reviewer",
    });

    assert.equal(result, "standalone result");
    assert.match(seen.prompt ?? "", /Be skeptical and concise/);
    assert.match(seen.prompt ?? "", /Inspect this change/);
    assert.equal(seen.options?.model, "provider/reviewer");
    assert.deepEqual(seen.options?.toolNames, ["read", "grep"]);
    assert.deepEqual(seen.options?.disallowedToolNames, ["edit"]);
    assert.equal(seen.options?.agentType, "reviewer");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("subagent tool executes one direct delegated task", async () => {
  const seen: { prompt?: string; options?: Record<string, unknown> } = {};
  const manager = fakeManager(process.cwd(), seen);
  const tool = createSubagentTool({ manager });
  const result = await tool.execute("subagent-test", { prompt: "Do one thing" }, undefined, undefined, undefined);

  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[0]?.text, "standalone result");
  assert.equal(result.details?.standalone, true);
  assert.equal(seen.prompt, "Do one thing");
});

test("/agent runs one prompt and reports the result", async () => {
  let command: ((args: string, ctx: any) => Promise<void>) | undefined;
  const notices: string[] = [];
  const seen: { prompt?: string; options?: Record<string, unknown> } = {};
  registerSubagentCommand(
    {
      getCommands: () => [],
      registerCommand: (_name: string, definition: { handler: (args: string, ctx: any) => Promise<void> }) => {
        command = definition.handler;
      },
    } as any,
    () => fakeManager(process.cwd(), seen),
    () => process.cwd(),
  );
  await command?.("check this", {
    waitForIdle: async () => {},
    ui: { notify: (text: string) => notices.push(text) },
  });
  assert.equal(seen.prompt, "check this");
  assert.deepEqual(notices, ["standalone result"]);
});

test("unknown standalone agent types fail clearly", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-subagent-"));
  try {
    await assert.rejects(
      () => runStandaloneAgent(fakeManager(cwd, {}), { prompt: "task", agentType: "missing" }),
      /Unknown agent type "missing"/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
