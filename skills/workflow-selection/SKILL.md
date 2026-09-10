---
name: workflow-selection
description: Use when deciding how to execute a non-trivial task. Choose direct tools for small/simple work and the `workflow` tool for parallel or decomposable research, implementation, review, or verification.
---

# Workflow selection

Use this skill at the start of substantive work when the dynamic `workflow` tool is available. This skill owns only the routing decision: direct tools versus workflow, and the smallest workflow shape. `workflow-patterns` owns built-in recipe details; `workflow-authoring` owns JavaScript workflow scripts; `aw-implement`, `aw-review`, and `aw-test` still own their respective engineering processes.

## Decide from the task

Do not let the literal presence or absence of the word “workflow” determine the route. Select the execution path from the actual work requested and the repository evidence.

Choose **direct tools** when the task is:

- a single known-file read, edit, rename, or deletion;
- a focused bug fix with a known call path and one or two checks;
- a simple question, explanation, lookup, or deterministic command;
- a small change where orchestration overhead exceeds the independent work.

Choose **workflow** when the task has two or more substantially independent work units or benefits from independent evidence, such as:

- broad repository discovery before implementation;
- independent research or source comparison;
- multi-angle code, security, or architecture review;
- parallel tests, audits, or verification passes;
- decomposable implementation with separate inspect, change, and verify work;
- a large task where bounded subagents reduce context loss or duplicate exploration.

For ambiguous scope, do the smallest direct inspection needed to decide. Do not use a workflow merely because one is available. Do not create subagents for trivial work, conversation, or one deterministic edit.

## Choose the smallest workflow

1. If the request clearly matches a built-in recipe, call the `workflow` tool with its `name` and `args`; prefer the reviewed recipe over rewriting it.
2. Otherwise author a bounded JavaScript workflow only when the work needs custom topology. Include a literal `meta` header, at least one `agent()` call, unique labels, bounded concurrency, and explicit verification.
3. Use `parallel` for independent tasks, `pipeline` for ordered per-item stages, and a final synthesis agent only when results need combining.
4. Pass enough repository paths and task context to every child. Give children explicit roles and time limits. Treat `null` as missing coverage and report it.
5. Keep production edits in the parent or an explicitly assigned implementation child according to the active engineering skill. Run focused checks before broad verification.

## Completion check

Before acting, silently identify the reason for the selected path: direct simplicity or workflow decomposition. After a workflow, verify the returned result, child failures, and required checks before reporting completion. If the workflow tool is unavailable or fails closed, continue with direct tools when safe; never pretend that subagents ran.

The user should experience the right execution path rather than being asked to choose an implementation topology.
