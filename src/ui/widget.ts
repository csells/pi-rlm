/**
 * Persistent RLM widget rendering (§10.1).
 */

import { Text } from "@mariozechner/pi-tui";
import type { CallTree, OperationEntry } from "../engine/call-tree.js";
import type { ExtensionContext, IExternalStore, RlmConfig } from "../types.js";
import type { Phase } from "./phases.js";

interface WidgetState {
  enabled: boolean;
  config: Pick<RlmConfig, "maxChildCalls">;
  store: Pick<IExternalStore, "getFullIndex">;
  callTree: Pick<
    CallTree,
    "getActive" | "maxActiveDepth" | "getActiveOperation"
  >;
  activePhases: Set<Phase | string>;
}

const PHASE_PRIORITY: Phase[] = [
  "batching",
  "querying",
  "synthesizing",
  "ingesting",
  "searching",
  "externalizing",
];

/**
 * Build the debounced widget update function used by state.updateWidget(ctx).
 */
export function createWidgetUpdater(state: WidgetState): (ctx: ExtensionContext) => void {
  let widgetDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  return (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    if (widgetDebounceTimer) {
      clearTimeout(widgetDebounceTimer);
    }

    widgetDebounceTimer = setTimeout(() => {
      const ui = (ctx as any).ui;
      if (!ui?.setWidget) return;

      ui.setWidget("rlm", (_tui: any, theme: any) => {
        const text = renderWidgetText(state, ctx, theme);
        return new Text(text, 0, 0);
      });
    }, 200);
  };
}

function renderWidgetText(state: WidgetState, ctx: ExtensionContext, theme: any): string {
  if (!state.enabled) {
    return theme.fg("dim", "RLM: off");
  }

  const index = state.store.getFullIndex();

  if (state.activePhases.size === 0) {
    const tokens = formatTokens(index.totalTokens);
    return (
      theme.fg("accent", "RLM: on") +
      theme.fg("muted", ` (${index.objects.length} objects, ${tokens})`) +
      theme.fg("dim", " | /rlm off to disable")
    );
  }

  const displayPhase =
    PHASE_PRIORITY.find((phase) => state.activePhases.has(phase)) ?? "processing";

  const activeCalls = state.callTree.getActive();
  const depth = state.callTree.maxActiveDepth();
  const activeOp = state.callTree.getActiveOperation();

  const budget = activeOp
    ? `${activeOp.childCallsUsed}/${state.config.maxChildCalls}`
    : `0/${state.config.maxChildCalls}`;

  const costStr = formatCost(activeOp);

  const lines = [
    theme.fg("warning", `RLM: ${displayPhase}`) +
      theme.fg(
        "muted",
        ` | depth: ${depth} | children: ${activeCalls.length} | budget: ${budget}${costStr}`,
      ),
  ];

  const usage = ctx.getContextUsage();
  if (usage && usage.tokens !== null) {
    lines.push(
      theme.fg(
        "dim",
        `  context: ${usage.tokens.toLocaleString()} tokens | store: ${formatTokens(index.totalTokens)}`,
      ),
    );
  } else {
    lines.push(theme.fg("dim", `  context: unknown | store: ${formatTokens(index.totalTokens)}`));
  }

  return lines.join("\n");
}

function formatCost(activeOp: OperationEntry | undefined): string {
  if (!activeOp) return "";

  const est = activeOp.estimatedCost ?? 0;
  const act = activeOp.actualCost ?? 0;

  if (est <= 0 && act <= 0) {
    return "";
  }

  return ` | est: $${est.toFixed(4)} actual: $${act.toFixed(4)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tokens`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K tokens`;
  return `${n} tokens`;
}
