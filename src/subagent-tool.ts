import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadAgentRegistry, resolveAgentType } from "./agent-registry.js";
import { isCommandRegistered } from "./command-registry.js";
import { type StandaloneAgentOptions, WorkflowManager } from "./workflow-manager.js";

const subagentSchema = Type.Object({
  prompt: Type.String({ description: "The task for the standalone subagent." }),
  agentType: Type.Optional(
    Type.String({ description: "Optional named project/user agent definition for role instructions and tool policy." }),
  ),
  model: Type.Optional(Type.String({ description: "Optional provider/model or model id." })),
  tier: Type.Optional(Type.String({ description: "Optional model tier such as small, medium, or big." })),
  isolation: Type.Optional(Type.Literal("worktree", { description: "Run the subagent in a temporary Git worktree." })),
  timeoutMs: Type.Optional(Type.Number({ description: "Optional timeout in milliseconds." })),
});

type SubagentInput = {
  prompt: string;
  agentType?: string;
  model?: string;
  tier?: string;
  isolation?: "worktree";
  timeoutMs?: number;
};

type ManagerLike = Pick<WorkflowManager, "runAgent" | "getCwd">;

export interface SubagentToolOptions {
  cwd?: string;
  manager?: ManagerLike;
  getManager?: () => ManagerLike;
  getCwd?: () => string;
}

function resolveRequest(input: SubagentInput, cwd: string): { prompt: string; options: StandaloneAgentOptions } {
  const registry = loadAgentRegistry(cwd);
  const definition = resolveAgentType(input.agentType, registry);
  if (input.agentType && !definition) {
    throw new Error(
      `Unknown agent type "${input.agentType}". Add .pi/agents/${input.agentType}.md or ~/.pi/agent/agents/${input.agentType}.md.`,
    );
  }

  const rolePrompt = definition?.prompt?.trim();
  const prompt = rolePrompt ? `${rolePrompt}\n\nTask:\n${input.prompt}` : input.prompt;
  return {
    prompt,
    options: {
      agentType: input.agentType,
      model: input.model ?? definition?.model,
      tier: input.tier,
      toolNames: definition?.tools,
      disallowedToolNames: definition?.disallowedTools,
      isolation: input.isolation ?? definition?.isolation,
      timeoutMs: input.timeoutMs,
    },
  };
}

export async function runStandaloneAgent(
  manager: ManagerLike,
  input: SubagentInput,
  cwd = manager.getCwd(),
  signal?: AbortSignal,
): Promise<string> {
  const request = resolveRequest(input, cwd);
  const result = await manager.runAgent(request.prompt, { ...request.options, signal });
  return result;
}

export function createSubagentTool(options: SubagentToolOptions = {}): ToolDefinition<typeof subagentSchema, any> {
  const fallbackCwd = options.cwd ?? process.cwd();
  const fallbackManager = options.manager ?? new WorkflowManager({ cwd: fallbackCwd });
  const getManager = () => options.getManager?.() ?? fallbackManager;
  const getCwd = () => options.getCwd?.() ?? fallbackCwd;

  return {
    name: "subagent",
    label: "Subagent",
    description: "Run one standalone subagent directly, without authoring or starting a workflow.",
    promptSnippet: "Use for one delegated task when multi-agent orchestration is unnecessary.",
    parameters: subagentSchema,
    async execute(_toolCallId, params, signal) {
      const manager = getManager();
      if (!manager) throw new Error("The standalone subagent manager is not available.");
      const text = await runStandaloneAgent(manager, params, getCwd(), signal);
      return {
        content: [{ type: "text", text }],
        details: { agentType: params.agentType, standalone: true },
      };
    },
  } as ToolDefinition<typeof subagentSchema, any>;
}

export function registerSubagentCommand(pi: ExtensionAPI, getManager: () => ManagerLike, getCwd: () => string): void {
  if (isCommandRegistered(pi, "agent")) return;
  pi.registerCommand("agent", {
    description: "Run one standalone subagent: /agent <prompt>",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const prompt = args.trim();
      if (!prompt) {
        ctx.ui.notify("Usage: /agent <prompt>", "warning");
        return;
      }
      await ctx.waitForIdle();
      try {
        const text = await runStandaloneAgent(getManager(), { prompt }, getCwd());
        ctx.ui.notify(text, "info");
      } catch (error) {
        ctx.ui.notify(`Standalone subagent failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
