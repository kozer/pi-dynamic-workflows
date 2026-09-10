import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  resolveWorkflowTranscriptDir,
  type WorkflowTranscriptManifest,
  writeWorkflowTranscriptManifest,
} from "../src/workflow.js";

test("workflow transcript manifests index agent sessions", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-transcript-manifest-"));
  try {
    const transcriptDir = resolveWorkflowTranscriptDir({ transcriptDir: "transcripts" }, cwd, {
      name: "manifest_demo",
      description: "manifest test",
    });
    const manifestPath = await writeWorkflowTranscriptManifest(
      transcriptDir,
      { name: "manifest_demo", description: "manifest test" },
      [
        {
          label: "research",
          phase: "Explore",
          status: "done",
          transcriptPath: join(transcriptDir, "research.jsonl"),
          sessionId: "session-1",
          resolvedModel: "provider/model",
        },
      ],
      { status: "success" },
    );

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as WorkflowTranscriptManifest;
    assert.equal(manifest.workflow.name, "manifest_demo");
    assert.equal(manifest.outcome.status, "success");
    assert.equal(manifest.transcripts[0]?.sessionId, "session-1");
    assert.equal(manifest.transcripts[0]?.resolvedModel, "provider/model");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
