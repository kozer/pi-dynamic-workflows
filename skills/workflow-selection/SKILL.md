---
name: workflow-selection
description: Use when deciding how to execute work that may span multiple files, roles, or independent checks. Choose direct tools, `subagent`, or `workflow` from observable task shape.
---

# Workflow selection

Use this skill before acting when the task may span files, roles, or independent checks and delegation tools are available. It owns only route selection; `workflow-patterns` owns built-in recipes and `workflow-authoring` owns workflow JavaScript. Task-specific skills retain ownership of their own processes.

## Route from observable shape

Do not use “non-trivial” as a threshold and do not wait for the word “workflow”. Inspect the request, likely files, diff, and required checks. Select the smallest route that preserves independent coverage:

- **Direct tools:** one known file or one tightly coupled call path, one concern, and a local check; also questions, lookups, and deterministic commands.
- **`subagent`:** one self-contained role that benefits from separate context or an independent opinion, such as focused research, one isolated implementation slice, or a concrete diff review.
- **`workflow`:** two or more independently useful roles or axes, or likely scope across multiple files/packages with separate boundaries. Signals include repo-wide discovery, independent source comparison, multi-perspective review, parallel verification, or separate inspect/change/verify stages.

Multiple files alone do not require a workflow when the changes are tightly coupled and one agent must coordinate them. Conversely, one file may justify delegation when it needs an independent review or separate research.

## Execute the selected route

1. Use `subagent` for one bounded delegation; use `workflow` for multiple agents or orchestration.
2. Prefer a matching built-in workflow recipe. Otherwise author a bounded JavaScript script with literal `meta`, at least one `agent()` call, unique labels, bounded concurrency, and verification.
3. Use `parallel` for independent work and `pipeline` for ordered stages. Give each child self-contained context, paths, constraints, and expected output.
4. Keep production edits with the parent or an explicitly assigned implementation child under the active task-specific process. Treat missing child results as missing coverage.

## Completion check

Select the route without asking the user to choose its topology. Verify child results and required checks. If delegation is unavailable or fails closed, continue directly when safe and report the coverage gap; never imply that delegation occurred.
