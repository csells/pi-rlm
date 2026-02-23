/**
 * Pi-RLM Extension Entry Point
 * Initializes the extension, wires up components, and registers tools/commands.
 */

import { CallTree } from "./engine/call-tree.js";
import { CostEstimator } from "./engine/cost.js";
import { RecursiveEngine } from "./engine/engine.js";
import { buildRlmQueryTool } from "./tools/query.js";
import { buildRlmBatchTool } from "./tools/batch.js";
import { DEFAULT_CONFIG } from "./config.js";
import { RlmConfig, ExtensionContext, IExternalStore, ITrajectoryLogger, IWarmTracker } from "./types.js";

/**
 * Shared state object — created in activate() and shared across all components via closure.
 */
interface RlmState {
  enabled: boolean;
  config: RlmConfig;
  store: IExternalStore;
  engine: RecursiveEngine;
  callTree: CallTree;
  costEstimator: CostEstimator;
  trajectory: ITrajectoryLogger;
  warmTracker: IWarmTracker;
  activePhases: Set<string>;
}

// ============================================================================
// Extension Entry Point
// ============================================================================

/**
 * Activate the Pi-RLM extension.
 * Called by Pi when the extension is loaded.
 */
export default function activate(pi: any): void {
  console.log("[pi-rlm] Extension activated");

  // Create shared state (will be populated by dependent components)
  const state: Partial<RlmState> = {
    enabled: true,
    config: DEFAULT_CONFIG,
    activePhases: new Set(),
  };

  // Note: Full initialization requires:
  // 1. task-1 to provide extension hooks and types
  // 2. task-2 to provide ExternalStore, TrajectoryLogger, WarmTracker
  //
  // This is a placeholder showing the structure. When task-1 and task-2
  // are available, uncomment the code below and wire it all together.

  // ========================================================================
  // TODO: Wire up components when task-1 and task-2 are complete
  // ========================================================================

  // Example (to be implemented):
  /*
  const storeDir = path.join(ctx.cwd, ".pi", "rlm", sessionId);
  state.store = new ExternalStore(storeDir);
  state.trajectory = new TrajectoryLogger(storeDir);
  state.warmTracker = new WarmTracker(config.warmTurns);

  state.callTree = new CallTree(config.maxChildCalls);
  state.costEstimator = new CostEstimator(state.store);
  state.engine = new RecursiveEngine(
    state.config,
    state.store,
    state.trajectory,
    state.callTree,
    state.costEstimator,
    state.warmTracker
  );

  // Register event handlers
  pi.on("context", safeHandler("context", onContext));
  pi.on("session_before_compact", safeHandler("compact", onBeforeCompact));

  // Register tools
  registerTools(pi, state as RlmState);

  // Register commands
  registerCommands(pi, state as RlmState);

  // Set up widget
  setupWidget(pi, state as RlmState);
  */

  console.log("[pi-rlm] Initialization placeholder — awaiting task-1 and task-2 to complete");
}

// ============================================================================
// Tool Registration
// ============================================================================

/**
 * Register all RLM tools with the Pi extension.
 */
function registerTools(pi: any, state: RlmState): void {
  console.log("[pi-rlm] Registering tools...");

  // Register rlm_query
  const queryTool = buildRlmQueryTool(
    state.config,
    state.engine,
    state.callTree,
    state.costEstimator,
    state.store,
    state.warmTracker,
    () => state.enabled,
    state.activePhases,
  );

  pi.registerTool({
    name: queryTool.name,
    label: queryTool.label,
    description: queryTool.description,
    parameters: queryTool.parameters,
    execute: queryTool.execute,
  });

  // Register rlm_batch
  const batchTool = buildRlmBatchTool(
    state.config,
    state.engine,
    state.callTree,
    state.costEstimator,
    state.store,
    state.warmTracker,
    () => state.enabled,
    state.activePhases,
  );

  pi.registerTool({
    name: batchTool.name,
    label: batchTool.label,
    description: batchTool.description,
    parameters: batchTool.parameters,
    execute: batchTool.execute,
  });

  console.log("[pi-rlm] Tools registered: rlm_query, rlm_batch");
}

// ============================================================================
// Command Registration
// ============================================================================

/**
 * Register RLM commands with the Pi extension.
 */
function registerCommands(pi: any, state: RlmState): void {
  console.log("[pi-rlm] Registering commands...");

  pi.registerCommand("rlm", {
    description: "RLM status and control. Usage: /rlm [on|off|cancel]",
    handler: async (args: string | undefined, ctx: ExtensionContext) => {
      const subcommand = args?.trim().toLowerCase();

      if (subcommand === "on") {
        state.enabled = true;
        state.config.enabled = true;
        if (ctx.hasUI && (ctx as any).ui?.notify) {
          (ctx as any).ui.notify("RLM enabled. Context externalization is active.", "success");
        }
        return;
      }

      if (subcommand === "off") {
        state.callTree.abortAll();
        state.enabled = false;
        state.config.enabled = false;
        if (ctx.hasUI && (ctx as any).ui?.notify) {
          (ctx as any).ui.notify("RLM disabled. Pi will use standard compaction. External store preserved on disk.", "info");
        }
        return;
      }

      if (subcommand === "cancel") {
        const active = state.callTree.getActive();
        if (active.length === 0) {
          if (ctx.hasUI && (ctx as any).ui?.notify) {
            (ctx as any).ui.notify("No active RLM operations.", "info");
          }
          return;
        }
        state.callTree.abortAll();
        if (ctx.hasUI && (ctx as any).ui?.notify) {
          (ctx as any).ui.notify(`Cancelled ${active.length} active operation(s). Partial results preserved.`, "warning");
        }
        return;
      }

      // Default: show status
      if (ctx.hasUI && (ctx as any).ui?.notify) {
        (ctx as any).ui.notify(`RLM: ${state.enabled ? "ON" : "OFF"}`, "info");
      } else {
        console.log(`[pi-rlm] RLM: ${state.enabled ? "ON" : "OFF"}`);
      }
    },
  });

  console.log("[pi-rlm] Commands registered: /rlm");
}

// ============================================================================
// Event Handlers
// ============================================================================

/**
 * Wrap an event handler with error handling.
 */
function safeHandler<T>(name: string, fn: (...args: any[]) => Promise<T>) {
  return async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error(`[pi-rlm] ${name} error:`, err);
      return undefined;
    }
  };
}

// ============================================================================
// Widget Setup
// ============================================================================

/**
 * Set up the RLM status widget.
 */
function setupWidget(pi: any, state: RlmState): void {
  // Widget will be set up by the UI layer in a later phase
  console.log("[pi-rlm] Widget setup placeholder");
}

// ============================================================================
// Exports
// ============================================================================

export { CallTree, CostEstimator, RecursiveEngine, resolveChildModel } from "./engine/index.js";
export * from "./types.js";
