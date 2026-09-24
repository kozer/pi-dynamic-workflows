import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow } from "../src/workflow.js";

test("the in-worker VM rejects constructor and code-generation escapes", async () => {
  const scripts = [
    `export const meta = { name: "constructor_escape", description: "escape" }\nreturn log.constructor("return process")()`,
    `export const meta = { name: "eval_escape", description: "eval" }\nreturn eval("1 + 1")`,
    `export const meta = { name: "function_escape", description: "function" }\nreturn Function("return 1")()`,
    `export const meta = { name: "wasm_escape", description: "wasm" }\nreturn WebAssembly.Module(new Uint8Array())`,
  ];

  for (const script of scripts) {
    await assert.rejects(
      runWorkflow(script, { sandbox: "none" }),
      /[Cc]ode generation|WebAssembly|not defined|process/,
    );
  }
});
