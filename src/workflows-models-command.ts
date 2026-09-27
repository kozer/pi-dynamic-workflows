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
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  KeybindingsManager,
  ScopedModel,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, getKeybindings, Input, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { listAvailableModelSpecs, listAvailableModels } from "./agent.js";
import {
  canonicalModelSpec,
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

/**
 * A model entry in the picker list, mirroring Pi's native /model selector.
 */
interface PickerModelEntry {
  spec: string;
  provider: string;
  id: string;
  name?: string;
}

/** Search-text shape mirrors Pi's `getModelSelectorSearchText` (provider-forward, for proxy IDs). */
function modelSelectorSearchText(item: PickerModelEntry): string {
  const name = item.name ? ` ${item.name}` : "";
  return `${item.provider} ${item.provider}/${item.id} ${item.provider} ${item.id}${name}`;
}

/** Split `provider/id` spec into parts; tolerates specs without a provider prefix. */
function specParts(spec: string): { provider: string; id: string } {
  const idx = spec.indexOf("/");
  if (idx <= 0) return { provider: "", id: spec };
  return { provider: spec.slice(0, idx), id: spec.slice(idx + 1) };
}

/**
 * Interactive editor for a single tier — native-style model picker plus optional
 * thinking-level picker.
 *
 * The model picker mirrors Pi's built-in /model selector: a live fuzzy search
 * input, a Tab-toggled "all | scoped" filter (scoped = the host session's
 * scoped-models list from `ctx.scopedModels`), and native list rendering
 * (cursor, current marker, provider badges, scroll indicator). When the host
 * session has scoped models, the picker opens on the scoped view, like /model.
 *
 * Returns the updated tiers object, or null if nothing changed.
 */
export async function editSingleTier(
  ctx: ExtensionCommandContext,
  tiers: Record<string, string>,
  tierName: string,
): Promise<Record<string, string> | null> {
  const available = listAvailableModelSpecs(ctx.modelRegistry);
  const knownSpecs = available.length > 0 ? available : undefined;
  const current = tiers[tierName];
  const currentParts = splitModelSpecThinking(current, knownSpecs);

  // "all" list: every available model, as native-style entries.
  const allEntries: PickerModelEntry[] = available.map((spec) => {
    const { provider, id } = specParts(spec);
    return { spec, provider, id };
  });

  // "scoped" list: the host session's scoped models (same set /scoped-models
  // manages). Entries missing from the available list (stale scope) are kept —
  // Pi's native selector keeps refreshed scoped entries too.
  const scopedModels = readScopedModels(ctx);
  const availableSet = new Set(allEntries.map((entry) => entry.spec));
  const scopedEntries: PickerModelEntry[] = scopedModels.map((scoped) => {
    const spec = canonicalModelSpec(scoped.model);
    const existing = availableSet.has(spec) ? allEntries.find((entry) => entry.spec === spec) : undefined;
    if (existing) return existing;
    return { spec, provider: scoped.model.provider, id: scoped.model.id, name: scoped.model.name };
  });

  const selectedModel = await pickModelNativeStyle(ctx, {
    tierName,
    currentModelSpec: currentParts.modelSpec,
    allEntries,
    scopedEntries,
  });
  if (!selectedModel) return null;

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

/** Read the host session's scoped models defensively (older SDKs may lack the getter). */
function readScopedModels(ctx: ExtensionCommandContext): ScopedModel[] {
  try {
    const scoped = (ctx as { scopedModels?: readonly ScopedModel[] }).scopedModels;
    return scoped ? [...scoped] : [];
  } catch {
    return [];
  }
}

interface NativePickerOptions {
  tierName: string;
  currentModelSpec: string;
  allEntries: PickerModelEntry[];
  scopedEntries: PickerModelEntry[];
}

/**
 * The native-style picker dialog. Extracted from editSingleTier so the
 * thinking-level flow and tests stay simple; renders and behaves like Pi's
 * built-in /model selector.
 */
async function pickModelNativeStyle(
  ctx: ExtensionCommandContext,
  options: NativePickerOptions,
): Promise<string | null> {
  const { tierName, currentModelSpec, allEntries, scopedEntries } = options;

  return ctx.ui.custom<string | null>(
    (tui: TUI, theme: Theme, _keybindings: KeybindingsManager, done: (result: string | null) => void) => {
      const container = new Container();

      const titleText = currentModelSpec
        ? `Pick a model for "${tierName}" (current: ${currentModelSpec})`
        : `Pick a model for "${tierName}"`;
      container.addChild(new Text(theme.fg("accent", titleText), 1, 0));

      // Scope line — only when the session actually has scoped models, exactly
      // like /model: the hint doubles as the current scope display.
      const hasScoped = scopedEntries.length > 0;
      let scope = hasScoped ? "scoped" : "all";
      const scopeColors = () => ({
        all: theme.fg(scope === "all" ? "accent" : "muted", "all"),
        scoped: theme.fg(scope === "scoped" ? "accent" : "muted", "scoped"),
      });
      let scopeText: Text | undefined;
      let scopeHintText: Text | undefined;
      if (hasScoped) {
        scopeText = new Text("", 0, 0);
        const renderScopeLine = () => {
          const colors = scopeColors();
          scopeText?.setText(`${theme.fg("muted", "Scope: ")}${colors.all}${theme.fg("muted", " | ")}${colors.scoped}`);
        };
        renderScopeLine();
        container.addChild(scopeText);
        scopeHintText = new Text(theme.fg("dim", "tab scope (all/scoped)"), 0, 0);
        container.addChild(scopeHintText);
      } else {
        container.addChild(new Text(theme.fg("warning", "Only showing models from configured providers."), 0, 0));
      }
      container.addChild(new Spacer(1));

      // Search input — type to fuzzy-filter, Enter selects the top match.
      const searchInput = new Input();
      searchInput.onSubmit = () => {
        const filtered = currentFiltered();
        if (filtered.length > 0) done(filtered[0].spec);
      };
      container.addChild(searchInput);
      container.addChild(new Spacer(1));

      const listContainer = new Container();
      container.addChild(listContainer);
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", "enter select  esc cancel  · thinking is chosen next"), 1, 0));

      const sortEntries = (entries: PickerModelEntry[]): PickerModelEntry[] => {
        const sorted = [...entries];
        sorted.sort((a, b) => {
          const aIsCurrent = a.spec === currentModelSpec;
          const bIsCurrent = b.spec === currentModelSpec;
          if (aIsCurrent && !bIsCurrent) return -1;
          if (!aIsCurrent && bIsCurrent) return 1;
          return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
        });
        return sorted;
      };
      const allSorted = sortEntries(allEntries);
      const scopedSorted = sortEntries(scopedEntries);

      const activeSorted = () => (scope === "scoped" ? scopedSorted : allSorted);
      let filtered: PickerModelEntry[] = activeSorted();
      // Start on the tier's current model (like /model starts on the session's),
      // computed against the sorted list the cursor actually navigates.
      let selectedIndex = Math.max(
        0,
        filtered.findIndex((entry) => entry.spec === currentModelSpec),
      );

      const applyFilter = () => {
        const query = searchInput.getValue();
        const active = activeSorted();
        if (query) {
          filtered = fuzzyFilter(active, query, modelSelectorSearchText);
        } else {
          filtered = active;
        }
        // With a query, highlight the best match; without, keep position clamped.
        selectedIndex = query ? 0 : Math.min(selectedIndex, Math.max(0, filtered.length - 1));
        updateList();
      };
      const currentFiltered = () => filtered;

      const updateList = () => {
        listContainer.clear();
        const maxVisible = 10;
        const startIndex = Math.max(
          0,
          Math.min(selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible),
        );
        const endIndex = Math.min(startIndex + maxVisible, filtered.length);
        for (let i = startIndex; i < endIndex; i++) {
          const entry = filtered[i];
          if (!entry) continue;
          const isSelected = i === selectedIndex;
          const isCurrent = entry.spec === currentModelSpec;
          const cursor = isSelected ? theme.fg("accent", "→ ") : "  ";
          const currentMarker = isCurrent ? theme.fg("accent", "✓ ") : "  ";
          const modelText = isSelected ? theme.fg("accent", entry.id) : entry.id;
          const providerBadge = theme.fg("muted", `[${entry.provider}]`);
          listContainer.addChild(new Text(`${cursor}${currentMarker}${modelText} ${providerBadge}`, 0, 0));
        }
        if (startIndex > 0 || endIndex < filtered.length) {
          listContainer.addChild(new Text(theme.fg("muted", `  (${selectedIndex + 1}/${filtered.length})`), 0, 0));
        }
        if (filtered.length === 0) {
          listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
        }
      };

      const setScope = (next: "all" | "scoped") => {
        if (scope === next || scopedEntries.length === 0) return;
        scope = next;
        if (scopeText) {
          const colors = scopeColors();
          scopeText.setText(`${theme.fg("muted", "Scope: ")}${colors.all}${theme.fg("muted", " | ")}${colors.scoped}`);
        }
        // Keep the cursor on the tier's current model when it exists in the new
        // scope; otherwise clamp.
        const active = activeSorted();
        const idx = active.findIndex((entry) => entry.spec === currentModelSpec);
        selectedIndex = idx >= 0 ? idx : Math.min(selectedIndex, Math.max(0, active.length - 1));
        applyFilter();
      };

      updateList();

      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          const kb = getKeybindings();
          // Tab toggles all/scoped — the /model interaction.
          if (kb.matches(data, "tui.input.tab")) {
            setScope(scope === "all" ? "scoped" : "all");
            tui.requestRender();
            return;
          }
          // Up arrow - wrap to bottom when at top
          if (kb.matches(data, "tui.select.up")) {
            if (filtered.length === 0) return;
            selectedIndex = (selectedIndex - 1 + filtered.length) % filtered.length;
            updateList();
            tui.requestRender();
            return;
          }
          // Down arrow - wrap to top when at bottom
          if (kb.matches(data, "tui.select.down")) {
            if (filtered.length === 0) return;
            selectedIndex = (selectedIndex + 1) % filtered.length;
            updateList();
            tui.requestRender();
            return;
          }
          // Enter picks the highlighted row
          if (kb.matches(data, "tui.select.confirm")) {
            const selected = filtered[selectedIndex];
            if (selected) done(selected.spec);
            return;
          }
          // Escape / Ctrl+C cancels
          if (kb.matches(data, "tui.select.cancel")) {
            done(null);
            return;
          }
          // Everything else feeds the search input
          searchInput.handleInput(data);
          applyFilter();
          tui.requestRender();
        },
      };
    },
  );
}

const DEFAULT_THINKING_CHOICE = "Default thinking (session setting)";
const THINKING_CHOICES = [DEFAULT_THINKING_CHOICE, ...THINKING_LEVELS] as const;

function fromThinkingChoice(choice: string | undefined): ModelThinkingLevel | undefined {
  return THINKING_LEVELS.find((level) => level === choice);
}
