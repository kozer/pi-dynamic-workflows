/**
 * `/workflows-models` command handler.
 *
 * Uses Pi's built-in `ctx.ui.select()`, `ctx.ui.confirm()`, and `ctx.ui.notify()`
 * to let users view and manage model tier configuration for workflows.
 *
 * Model selection draws from the host session's shared model registry so users
 * see every provider Pi can reach, including extension-registered providers such
 * as `ollama-cloud`.
 *
 * Each tier holds exactly one model spec string. The string may include Pi
 * CLI-style thinking suffixes, e.g. `openai-codex/gpt-5.5:xhigh`.
 * When editing a tier, users pick a model, then an optional thinking level.
 */

import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  Spacer,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import { listAvailableModelSpecs, listAvailableModels } from "./agent.js";
import {
  formatModelSpecWithThinking,
  type ModelThinkingLevel,
  splitModelSpecThinking,
  THINKING_LEVELS,
} from "./model-spec.js";
import {
  buildDefaultTierConfig,
  getModelTierConfigPath,
  getProjectModelTierConfigPath,
  loadModelTierConfig,
  type ModelTierConfig,
  saveModelTierConfig,
  sortedTierNames,
} from "./model-tier-config.js";

/**
 * Register the `/workflows-models` command with Pi.
 */
export function registerWorkflowModelsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("workflows-models", {
    description: "View and edit model tiers used by workflows (small/medium/big)",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      // Load the saved config, or build an in-memory default spread across the
      // available models. If the model registry is empty, fall back to the
      // current Pi model so the tiers are still usable. Pass the host session's
      // registry explicitly: since pi 0.80.8 the no-registry fallback inside
      // listAvailableModels() initializes asynchronously and reports [] on the
      // first call, which would rank defaults from an empty model list.
      const cwd = ctx.cwd || process.cwd();
      const globalPath = getModelTierConfigPath();
      const projectPath = getProjectModelTierConfigPath(cwd);
      let scope: "global" | "project" = existsSync(projectPath) ? "project" : "global";
      const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const defaults = () => buildDefaultTierConfig(currentModel, listAvailableModels(ctx.modelRegistry));
      const loadForScope = (next: "global" | "project"): ModelTierConfig => {
        if (next === "project") {
          return loadModelTierConfig({ cwd }) ?? defaults();
        }
        return loadModelTierConfig(globalPath) ?? defaults();
      };
      let config = loadForScope(scope);
      let dirty = false;

      const ensureFresh = (cfg: typeof config) => {
        config = cfg;
        dirty = true;
      };

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const tiers = sortedTierNames(config);
        const menuOptions: string[] = [];

        menuOptions.push(`Editing ${scope} tiers`);
        menuOptions.push("─".repeat(30));
        for (const name of tiers) {
          const model = config.tiers[name];
          menuOptions.push(`${name} tier → ${model}`);
        }
        menuOptions.push("─".repeat(30));
        menuOptions.push("Set one model for all tiers");
        menuOptions.push(scope === "project" ? "Switch to global" : "Switch to project");
        menuOptions.push("Reset to defaults");
        menuOptions.push(dirty ? "Save and exit" : "Exit");

        const choice = await ctx.ui.select(`Model tier configuration (${scope})`, menuOptions);

        if (!choice) break;

        if (choice === "Editing global tiers" || choice === "Editing project tiers") {
          continue;
        }

        // Handle "<tier> → [model]" selections
        for (const name of tiers) {
          if (choice.startsWith(`${name} tier →`)) {
            const updatedTiers = await editSingleTier(ctx, config.tiers, name);
            if (updatedTiers !== null) {
              ensureFresh({ ...config, tiers: updatedTiers });
            }
            break;
          }
        }

        if (choice === "Set one model for all tiers") {
          const updatedTiers = await editAllTiers(ctx, config.tiers);
          if (updatedTiers !== null) ensureFresh({ ...config, tiers: updatedTiers });
          continue;
        }

        if (choice === "Switch to global" || choice === "Switch to project") {
          const nextScope = choice === "Switch to project" ? "project" : "global";
          if (nextScope === scope) continue;
          if (dirty) {
            const confirmed = await ctx.ui.confirm("Switch scope", "Unsaved changes will be discarded. Continue?");
            if (!confirmed) continue;
          }
          scope = nextScope;
          config = loadForScope(scope);
          dirty = false;
          continue;
        }

        if (choice === "Reset to defaults") {
          const confirmed = await ctx.ui.confirm(
            "Reset model tiers",
            "This will reset tiers from your available model list. Continue?",
          );
          if (confirmed) {
            ensureFresh(buildDefaultTierConfig(currentModel, listAvailableModels(ctx.modelRegistry)));
            ctx.ui.notify("Tiers reset to defaults. Use 'Save and exit' to persist.", "info");
          }
        }

        if (choice === "Save and exit" || choice === "Exit") {
          if (choice === "Save and exit") {
            saveModelTierConfig(config, scope === "project" ? projectPath : globalPath);
            ctx.ui.notify(scope === "project" ? "Project model tiers saved." : "Model tiers saved.", "info");
          }
          break;
        }
      }
    },
  });
}

const DEFAULT_THINKING_CHOICE = "Default thinking (session setting)";
const THINKING_CHOICES = [DEFAULT_THINKING_CHOICE, ...THINKING_LEVELS] as const;

function fromThinkingChoice(choice: string | undefined): ModelThinkingLevel | undefined {
  return THINKING_LEVELS.find((level) => level === choice);
}

export function filterModelSpecs(specs: string[], query: string): string[] {
  const normalized = query.trim().toLowerCase();
  return normalized ? specs.filter((spec) => spec.toLowerCase().includes(normalized)) : specs;
}

async function selectModel(
  ctx: ExtensionCommandContext,
  current: string | undefined,
  title: string,
): Promise<string | null> {
  const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  const available = listAvailableModelSpecs(ctx.modelRegistry);
  const specs = [...new Set(sessionModel ? [sessionModel, ...available] : available)];
  const knownSpecs = specs.length > 0 ? specs : undefined;
  const currentParts = splitModelSpecThinking(current, knownSpecs);

  return ctx.ui.custom<string | null>((tui: TUI, theme: Theme, _keybindings, done) => {
    const container = new Container();
    let query = "";
    const selectTheme: SelectListTheme = {
      selectedPrefix: (t: string) => theme.bg("selectedBg", theme.fg("accent", t)),
      selectedText: (t: string) => theme.bg("selectedBg", theme.bold(t)),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
    };

    let selectList: SelectList;
    const createSelectList = () => {
      const items: SelectItem[] = filterModelSpecs(specs, query).map((m) => ({
        value: m,
        label: m === sessionModel ? `${m} (current session)` : m,
      }));
      const next = new SelectList(items, 12, selectTheme);
      const preferred = currentParts.modelSpec ?? (query ? undefined : sessionModel);
      if (preferred) {
        const idx = items.findIndex((item) => item.value === preferred);
        if (idx >= 0) next.setSelectedIndex(idx);
      }
      next.onSelect = (item) => done(item.value);
      next.onCancel = () => done(null);
      return next;
    };
    selectList = createSelectList();

    return {
      render: (w: number) => {
        container.clear();
        container.addChild(new Text(theme.fg("accent", title), 1, 0));
        container.addChild(new Text(theme.fg("muted", `Search: ${query || "all models"}`), 1, 0));
        container.addChild(new Spacer(1));
        container.addChild(selectList);
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", "type to search  ·  ↑↓ navigate  enter select  esc cancel"), 1, 0));
        return container.render(w);
      },
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        selectList.handleInput(data);
        if (data === "\b" || data === String.fromCharCode(127)) query = query.slice(0, -1);
        else if (/^[\\x20-\\x7e]$/.test(data)) query += data;
        else {
          tui.requestRender();
          return;
        }
        selectList = createSelectList();
        tui.requestRender();
      },
    };
  });
}

/**
 * Interactive editor for a single tier — scrollable model picker plus optional
 * thinking-level picker.
 *
 * Uses `ctx.ui.custom()` with Pi TUI's `SelectList` for proper scrollable list
 * with limited visible rows (like `/advisor`). The currently selected base
 * model is shown in the dialog title. After choosing the model, users can set
 * a Pi CLI-style thinking suffix or keep the session default.
 *
 * Returns the updated tiers object, or null if nothing changed.
 */
export async function editSingleTier(
  ctx: ExtensionCommandContext,
  tiers: Record<string, string>,
  tierName: string,
): Promise<Record<string, string> | null> {
  const current = tiers[tierName];
  const selectedModel = await selectModel(
    ctx,
    current,
    current ? `Pick a model for "${tierName}" (current: ${current})` : `Pick a model for "${tierName}"`,
  );
  if (!selectedModel) return null;

  const knownSpecs = listAvailableModelSpecs(ctx.modelRegistry);
  const currentParts = splitModelSpecThinking(current, knownSpecs.length > 0 ? knownSpecs : undefined);
  const currentThinkingLabel = currentParts.thinkingLevel ?? DEFAULT_THINKING_CHOICE;
  const thinkingChoice = await ctx.ui.select(
    `Thinking for "${tierName}" tier (current: ${currentThinkingLabel})`,
    THINKING_CHOICES.map((choice) => String(choice)),
  );
  if (!thinkingChoice) return null;

  const thinkingLevel = fromThinkingChoice(thinkingChoice);
  const result = formatModelSpecWithThinking(selectedModel, thinkingLevel);
  if (result === current) return null;

  ctx.ui.notify(`"${tierName}" tier → ${result}`, "info");
  return { ...tiers, [tierName]: result };
}

/** Apply one model to every tier while preserving each tier's thinking suffix. */
export function applyModelToAllTiers(tiers: Record<string, string>, modelSpec: string): Record<string, string> {
  const updated = Object.fromEntries(
    Object.entries(tiers).map(([name, current]) => {
      const { thinkingLevel } = splitModelSpecThinking(current);
      return [name, formatModelSpecWithThinking(modelSpec, thinkingLevel)];
    }),
  );
  return updated;
}

async function editAllTiers(
  ctx: ExtensionCommandContext,
  tiers: Record<string, string>,
): Promise<Record<string, string> | null> {
  const selectedModel = await selectModel(ctx, undefined, "Pick one model for all workflow tiers");
  if (!selectedModel) return null;

  const updated = applyModelToAllTiers(tiers, selectedModel);
  if (JSON.stringify(updated) === JSON.stringify(tiers)) return null;
  ctx.ui.notify(`All tiers → ${selectedModel} (thinking levels preserved)`, "info");
  return updated;
}
