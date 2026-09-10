---
name: workflow-selection
description: Use when deciding how to execute work that may span multiple files, roles, or independent checks. Choose direct tools, `subagent`, or `workflow` from observable task shape.
---

# Workflow selection

Use this skill before acting when the task may span files, roles, or independent checks and the delegation tools are available. It owns only route selection; `workflow-patterns` owns built-in recipes, `workflow-authoring` owns workflow JavaScript, and `aw-implement`, `aw-review`, and `aw-test` own their engineering processes.

## Route from observable shape

Do not use “non-trivial” as a threshold and do not wait for the word “workflow”. Inspect the request, likely files, diff, and required checks. Select the smallest route that preserves independent coverage:

- **Direct tools:** one known file or one tightly coupled call path, one concern, and a local check; also questions, lookups, and deterministic commands.
- **`subagent`:** one self-contained role that benefits from separate context or an independent opinion, such as reviewing a concrete diff, researching one source, or implementing one isolated slice.
- **`workflow`:** two or more independently useful roles or axes, or likely scope across multiple files/packages with separate boundaries. Signals include repo-wide discovery, independent source comparison, standards plus security review, parallel verification, or separate inspect/change/verify stages.

Multiple files alone do not require a workflow when the changes are tightly coupled and one agent must coordinate them. Conversely, one file may justify delegation when it needs an independent review or separate research.

### Review routing

For `aw-review`, prefer an independent `subagent` when the concrete diff spans several files, crosses package or architectural boundaries, or carries security, concurrency, data-loss, or migration risk. Use a `workflow` when the review needs multiple independent perspectives (for example correctness, security, and specification coverage). Review directly only when the change is focused and an independent pass would add no useful evidence.

### Implementation routing

For `aw-implement`, keep one tightly coupled vertical slice together. Use a `subagent` for one isolated slice with a clear owner. Use a `workflow` when the confirmed scope contains separately verifiable slices or independent research, implementation, and verification work. Do not split a coupled edit just to avoid doing it in the parent.

## Execute the selected route

1. Use `subagent` for one bounded delegation; use `workflow` for multiple agents or orchestration.
2. Prefer a matching built-in workflow recipe. Otherwise author a bounded JavaScript script with literal `meta`, at least one `agent()` call, unique labels, bounded concurrency, and verification.
3. Use `parallel` for independent work and `pipeline` for ordered stages. Give each child self-contained context, paths, constraints, and expected output.
4. Keep production edits with the parent or explicitly assigned implementation child under the active engineering skill. Treat missing child results as missing coverage.

## Completion check

Select the route without asking the user to choose its topology. Verify child results and required checks. If delegation is unavailable or fails closed, continue directly when safe and report the coverage gap; never imply that delegation occurred.
