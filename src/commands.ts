/**
 * Slash command registration for /rlm.
 * Covers §8 command set: status, on/off/cancel, config, externalize, store, inspect.
 */

import { DEFAULT_CONFIG, mergeConfig } from "./config.js";
import { showInspector } from "./ui/inspector.js";
import type { CallTree } from "./engine/call-tree.js";
import type { ExtensionContext, IExternalStore, RlmConfig } from "./types.js";

interface RlmCommandState {
  enabled: boolean;
  config: RlmConfig;
  store: IExternalStore;
  callTree: Pick<
    CallTree,
    | "abortAll"
    | "getActive"
    | "maxActiveDepth"
    | "getActiveOperation"
    | "setMaxChildCalls"
    | "getTree"
  >;
  storeHealthy: boolean;
  allowCompaction: boolean;
  forceExternalizeOnNextTurn: boolean;
  updateWidget: (ctx: ExtensionContext) => void;
}

export function registerCommands(pi: any, state: RlmCommandState): void {
  pi.registerCommand("rlm", {
    description:
      "RLM status and control. Usage: /rlm [on|off|cancel|config|inspect|externalize|store]",
    handler: async (args: string | undefined, ctx: ExtensionContext) => {
      const subcommand = args?.trim() ?? "";
      const [cmd = "", ...rest] = subcommand.split(/\s+/);
      const command = cmd.toLowerCase();
      const commandArgs = rest.join(" ");

      switch (command) {
        case "":
          showStatus(state, ctx);
          return;
        case "on":
          enableRlm(pi, state, ctx);
          return;
        case "off":
          disableRlm(pi, state, ctx);
          return;
        case "cancel":
          cancelOperations(state, ctx);
          return;
        case "config":
          updateConfig(pi, state, ctx, commandArgs);
          return;
        case "inspect":
          await showInspector(ctx, state.callTree);
          return;
        case "externalize":
          forceExternalize(state, ctx);
          return;
        case "store":
          showStore(state, ctx);
          return;
        default:
          notify(ctx, "Unknown /rlm subcommand. Try /rlm for status.", "warning");
          showStatus(state, ctx);
      }
    },
  });
}

function enableRlm(pi: any, state: RlmCommandState, ctx: ExtensionContext): void {
  state.enabled = true;
  state.config.enabled = true;
  persistConfig(pi, state.config);
  state.updateWidget(ctx);

  notify(ctx, "RLM enabled. Context externalization is active.", "success");
}

function disableRlm(pi: any, state: RlmCommandState, ctx: ExtensionContext): void {
  state.callTree.abortAll();
  state.enabled = false;
  state.config.enabled = false;
  state.allowCompaction = false;
  persistConfig(pi, state.config);
  state.updateWidget(ctx);

  notify(
    ctx,
    "RLM disabled. Pi will use standard compaction. External store preserved on disk.",
    "info",
  );
}

function cancelOperations(state: RlmCommandState, ctx: ExtensionContext): void {
  const activeOps = state.callTree.getActive();

  if (activeOps.length === 0) {
    notify(ctx, "No active RLM operations.", "info");
    return;
  }

  state.callTree.abortAll();
  state.updateWidget(ctx);

  notify(
    ctx,
    `Cancelled ${activeOps.length} active operation(s). Partial results preserved.`,
    "warning",
  );
}

function updateConfig(pi: any, state: RlmCommandState, ctx: ExtensionContext, args: string): void {
  if (!args.trim()) {
    const lines = ["RLM configuration:"];
    const keys = Object.keys(DEFAULT_CONFIG) as Array<keyof typeof DEFAULT_CONFIG>;

    for (const key of keys) {
      const value = state.config[key];
      lines.push(`  ${key}: ${String(value)}`);
    }

    if (state.config.childModel) {
      lines.push(`  childModel: ${state.config.childModel}`);
    }

    notify(ctx, lines.join("\n"), "info");
    return;
  }

  const updates: Partial<RlmConfig> = {};
  const errors: string[] = [];
  const pairs = args.split(/\s+/).filter(Boolean);

  for (const pair of pairs) {
    const [rawKey, ...valueParts] = pair.split("=");
    const value = valueParts.join("=").trim();
    const key = rawKey?.trim() as keyof RlmConfig | undefined;

    if (!key || value.length === 0) {
      errors.push(`Invalid argument: ${pair} (expected key=value)`);
      continue;
    }

    if (key === "childModel") {
      updates.childModel = value === "default" || value === "" ? undefined : value;
      continue;
    }

    if (!(key in DEFAULT_CONFIG)) {
      errors.push(`Unknown config key: ${String(key)}`);
      continue;
    }

    const baseline = DEFAULT_CONFIG[key as keyof typeof DEFAULT_CONFIG];

    if (typeof baseline === "boolean") {
      if (value === "true" || value === "false") {
        (updates as Record<string, unknown>)[key] = value === "true";
      } else {
        errors.push(`${String(key)} must be true or false`);
      }
      continue;
    }

    if (typeof baseline === "number") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        (updates as Record<string, unknown>)[key] = parsed;
      } else {
        errors.push(`${String(key)} must be numeric`);
      }
      continue;
    }

    (updates as Record<string, unknown>)[key] = value;
  }

  if (errors.length > 0) {
    notify(ctx, `Config update failed:\n${errors.join("\n")}`, "error");
    return;
  }

  state.config = mergeConfig({ ...state.config, ...updates });
  state.enabled = state.config.enabled;

  if (typeof updates.maxChildCalls === "number") {
    state.callTree.setMaxChildCalls(state.config.maxChildCalls);
  }

  persistConfig(pi, state.config);
  state.updateWidget(ctx);

  const updateLines = Object.entries(updates).map(([key, value]) => `  ${key}=${String(value)}`);
  notify(
    ctx,
    updateLines.length > 0
      ? `Updated RLM configuration:\n${updateLines.join("\n")}`
      : "No configuration changes applied.",
    "success",
  );
}

function forceExternalize(state: RlmCommandState, ctx: ExtensionContext): void {
  state.forceExternalizeOnNextTurn = true;
  notify(
    ctx,
    "Externalization will run on the next LLM call. Send a message to trigger it.",
    "info",
  );
}

function showStore(state: RlmCommandState, ctx: ExtensionContext): void {
  const index = state.store.getFullIndex();
  const lines = [
    "RLM store:",
    `  objects: ${index.objects.length}`,
    `  token estimate: ${formatTokens(index.totalTokens)}`,
    `  health: ${state.storeHealthy ? "healthy" : "degraded"}`,
  ];

  if (index.objects.length === 0) {
    lines.push("  (empty)");
  } else {
    lines.push("  recent objects:");
    const recent = index.objects.slice(-10).reverse();
    for (const obj of recent) {
      lines.push(
        `    ${obj.id} | ${obj.type} | ${obj.tokenEstimate.toLocaleString()} tokens | ${obj.description}`,
      );
    }

    if (index.objects.length > recent.length) {
      lines.push(`    ... and ${index.objects.length - recent.length} more`);
    }
  }

  notify(ctx, lines.join("\n"), "info");
}

function showStatus(state: RlmCommandState, ctx: ExtensionContext): void {
  const index = state.store.getFullIndex();
  const usage = ctx.getContextUsage();
  const activeOps = state.callTree.getActive();

  const lines = [
    `RLM: ${state.enabled ? "ON" : "OFF"}`,
    `External store: ${index.objects.length} objects, ${formatTokens(index.totalTokens)}`,
    `Working context: ${usage?.tokens?.toLocaleString() ?? "unknown"} tokens`,
  ];

  if (activeOps.length > 0) {
    lines.push(`Active operations: ${activeOps.length}`);
    lines.push(`Active depth: ${state.callTree.maxActiveDepth()}`);

    const activeOperation = state.callTree.getActiveOperation();
    if (activeOperation) {
      const est = activeOperation.estimatedCost;
      const act = activeOperation.actualCost;
      lines.push(
        `Cost: est $${est.toFixed(4)} | actual $${act.toFixed(4)}`,
      );
    }
  }

  if (!state.storeHealthy) {
    lines.push("Store health: degraded");
  }

  notify(ctx, lines.join("\n"), "info");
}

function persistConfig(pi: any, config: RlmConfig): void {
  if (typeof pi?.appendEntry !== "function") {
    return;
  }

  try {
    pi.appendEntry("rlm-config", config);
  } catch (err) {
    console.warn("[pi-rlm] Failed to persist config from /rlm command:", err);
  }
}

function notify(
  ctx: ExtensionContext,
  message: string,
  level: "success" | "info" | "warning" | "error",
): void {
  if (ctx.hasUI) {
    (ctx as any).ui?.notify?.(message, level);
    return;
  }

  console.log(`[pi-rlm] ${message}`);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tokens`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K tokens`;
  return `${n} tokens`;
}
