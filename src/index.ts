/**
 * Pi-RLM extension entry point.
 * Wires lifecycle handlers, context externalization, and tool/command registration.
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { registerCommands } from "./commands.js";
import { DEFAULT_CONFIG } from "./config.js";
import {
  ExternalizerState,
  onBeforeCompact,
  onContext,
} from "./context/externalizer.js";
import { ManifestBuilder } from "./context/manifest.js";
import { WarmTracker } from "./context/warm-tracker.js";
import { CallTree } from "./engine/call-tree.js";
import { CostEstimator } from "./engine/cost.js";
import { RecursiveEngine } from "./engine/engine.js";
import { emitEvent, safeHandler, safeToolExecute } from "./events.js";
import { ExternalStore, getRlmStoreDir } from "./store/store.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { buildRlmBatchTool } from "./tools/batch.js";
import { buildRlmQueryTool } from "./tools/query.js";
import { buildRlmPeekTool } from "./tools/peek.js";
import { buildRlmSearchTool } from "./tools/search.js";
import { buildRlmStatsTool } from "./tools/stats.js";
import { buildRlmIngestTool } from "./tools/ingest.js";
import { TrajectoryLogger } from "./trajectory.js";
import { createWidgetUpdater } from "./ui/widget.js";
import {
  ExtensionContext,
  IExternalStore,
  ITrajectoryLogger,
  IWarmTracker,
  RlmConfig,
} from "./types.js";

/**
 * Shared extension state.
 */
export interface RlmState extends ExternalizerState {
  config: RlmConfig;
  store: IExternalStore;
  manifest: ManifestBuilder;
  engine: RecursiveEngine;
  callTree: CallTree;
  costEstimator: CostEstimator;
  trajectory: ITrajectoryLogger;
  warmTracker: IWarmTracker;
  activePhases: Set<string>;
  sessionId: string;
  turnCount: number;
  storeHealthy: boolean;
  allowCompaction: boolean;
  forceExternalizeOnNextTurn: boolean;
  updateWidget: (ctx: ExtensionContext) => void;
}

function createBootstrapState(): RlmState {
  const sessionId = "bootstrap";
  const storeDir = getRlmStoreDir(process.cwd(), sessionId);
  const store = new ExternalStore(storeDir, sessionId);
  const warmTracker = new WarmTracker(DEFAULT_CONFIG.warmTurns);
  const trajectory = new TrajectoryLogger(storeDir);
  const callTree = new CallTree(DEFAULT_CONFIG.maxChildCalls);
  const costEstimator = new CostEstimator(store);
  const engine = new RecursiveEngine(
    DEFAULT_CONFIG,
    store,
    trajectory,
    callTree,
    costEstimator,
    warmTracker,
  );

  return {
    enabled: true,
    config: { ...DEFAULT_CONFIG },
    store,
    manifest: new ManifestBuilder(store),
    engine,
    callTree,
    costEstimator,
    trajectory,
    warmTracker,
    activePhases: new Set<string>(),
    sessionId,
    turnCount: 0,
    storeHealthy: true,
    allowCompaction: false,
    forceExternalizeOnNextTurn: false,
    updateWidget: (_ctx) => {
      // Widget wiring is added by task-12.
    },
  };
}

/**
 * Activate extension.
 */
export default function activate(pi: any): void {
  const state = createBootstrapState();
  state.updateWidget = createWidgetUpdater(state);

  pi.on(
    "session_start",
    safeHandler("session_start", async (event: any, ctx: ExtensionContext) => {
      await onSessionStart(event, ctx, pi, state);
    }),
  );

  pi.on(
    "before_agent_start",
    safeHandler(
      "before_agent_start",
      async (event: any, ctx: ExtensionContext) => onBeforeAgentStart(event, ctx, state),
    ),
  );

  pi.on(
    "context",
    safeHandler("context", async (event: any, ctx: ExtensionContext) => onContext(event, ctx, state, pi)),
  );

  pi.on(
    "session_before_compact",
    safeHandler(
      "compact",
      async (event: any, ctx: ExtensionContext) => onBeforeCompact(event, ctx, state),
    ),
  );

  pi.on(
    "session_before_switch",
    safeHandler(
      "switch",
      async (event: any, ctx: ExtensionContext) => onBeforeSwitch(event, ctx, pi, state),
    ),
  );

  pi.on(
    "session_shutdown",
    safeHandler(
      "shutdown",
      async (event: any, ctx: ExtensionContext) => onShutdown(event, ctx, state),
    ),
  );

  registerTools(pi, state);
  registerCommands(pi, state);
}

/**
 * session_start handler (§4.2).
 */
export async function onSessionStart(
  _event: any,
  ctx: ExtensionContext,
  pi: any,
  state: RlmState,
): Promise<void> {
  state.sessionId = (ctx as any).sessionManager?.getSessionFile?.() ?? "ephemeral";

  // Reconstruct config from session entries
  state.config = { ...DEFAULT_CONFIG };
  const entries = (ctx as any).sessionManager?.getEntries?.() ?? [];
  for (const entry of entries) {
    if (entry?.type === "custom" && entry?.customType === "rlm-config") {
      state.config = { ...DEFAULT_CONFIG, ...(entry.data ?? {}) };
    }
  }

  state.enabled = state.config.enabled;
  state.turnCount = 0;
  state.allowCompaction = false;
  state.forceExternalizeOnNextTurn = false;
  state.activePhases.clear();

  const storeDir = getRlmStoreDir(ctx.cwd, state.sessionId);
  const store = new ExternalStore(storeDir, state.sessionId);

  try {
    await store.initialize();
    state.storeHealthy = true;
  } catch (err) {
    state.storeHealthy = false;
    console.error("[pi-rlm] Store initialization failed, falling back to vanilla behavior:", err);
    if (ctx.hasUI) {
      (ctx as any).ui?.notify?.(
        "RLM store failed to initialize; falling back to standard Pi behavior.",
        "warning",
      );
    }
    return;
  }

  // Rebind session-scoped components
  state.store = store;
  state.manifest = new ManifestBuilder(store);
  state.warmTracker = new WarmTracker(state.config.warmTurns);
  state.trajectory = new TrajectoryLogger(storeDir);
  state.callTree = new CallTree(state.config.maxChildCalls);
  state.costEstimator = new CostEstimator(store);
  state.engine = new RecursiveEngine(
    state.config,
    state.store,
    state.trajectory,
    state.callTree,
    state.costEstimator,
    state.warmTracker,
  );

  // Rebuild in-memory fingerprint -> object map for stub replacement
  state.store.rebuildExternalizedMap();

  await maybeShowFirstRunNotification(ctx);

  const rlmDir = path.join(ctx.cwd, ".pi", "rlm");
  cleanupOldSessions(rlmDir, state.config.retentionDays).catch((err) => {
    console.warn("[pi-rlm] Session cleanup error:", err);
  });

  emitEvent(pi, "rlm:toggle", { enabled: state.enabled });

  if (pi?.events?.emit) {
    pi.events.emit("rlm:initialized", {
      sessionId: state.sessionId,
      enabled: state.enabled,
      timestamp: Date.now(),
    });
  }

  state.updateWidget(ctx);
}

/**
 * before_agent_start handler (§4.3).
 */
export async function onBeforeAgentStart(
  event: any,
  _ctx: ExtensionContext,
  state: Pick<RlmState, "enabled" | "config">,
): Promise<{ systemPrompt: string } | undefined> {
  if (!state.enabled) return;

  const rlmPrompt = buildSystemPrompt(state.config);
  const basePrompt = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";

  return {
    systemPrompt: basePrompt ? `${basePrompt}\n\n${rlmPrompt}` : rlmPrompt,
  };
}

/**
 * session_before_switch handler (§4.6).
 */
export async function onBeforeSwitch(
  _event: any,
  _ctx: ExtensionContext,
  pi: any,
  state: Pick<RlmState, "store" | "trajectory" | "config">,
): Promise<void> {
  await state.store.flush();
  await state.trajectory.flush();

  if (typeof pi?.appendEntry === "function") {
    try {
      pi.appendEntry("rlm-config", state.config);
      pi.appendEntry("rlm-index", state.store.getFullIndex());
    } catch (err) {
      console.warn("[pi-rlm] Failed to append switch metadata:", err);
    }
  }
}

/**
 * session_shutdown handler (§4.7).
 */
export async function onShutdown(
  _event: any,
  _ctx: ExtensionContext,
  state: Pick<RlmState, "store" | "trajectory">,
): Promise<void> {
  await state.store.flush();
  await state.trajectory.flush();
}

async function maybeShowFirstRunNotification(ctx: ExtensionContext): Promise<void> {
  const installedFlag = path.join(homedir(), ".pi", "rlm", ".installed");

  try {
    if (fs.existsSync(installedFlag)) return;

    if (ctx.hasUI) {
      (ctx as any).ui?.notify?.(
        "Pi-RLM is active. Use /rlm off to disable. Use /rlm for status.",
        "info",
      );
    }

    await fs.promises.mkdir(path.dirname(installedFlag), { recursive: true });
    await fs.promises.writeFile(installedFlag, new Date().toISOString());
  } catch (err) {
    console.warn("[pi-rlm] Failed first-run notification setup:", err);
  }
}

/**
 * Best-effort cleanup for stale session directories (§11.4).
 */
async function cleanupOldSessions(rlmDir: string, retentionDays: number): Promise<void> {
  await fs.promises.mkdir(rlmDir, { recursive: true });

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const entries = await fs.promises.readdir(rlmDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const sessionDir = path.join(rlmDir, entry.name);
    const indexPath = path.join(sessionDir, "index.json");

    try {
      const stat = await fs.promises.stat(indexPath);
      if (stat.mtimeMs < cutoff) {
        await fs.promises.rm(sessionDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore unreadable/malformed session folders.
    }
  }
}

function registerTools(pi: any, state: RlmState): void {
  const queryTool = buildRlmQueryTool(
    state.config,
    state.engine,
    state.callTree,
    state.costEstimator,
    state.store,
    state.warmTracker,
    () => state.enabled,
    state.activePhases,
    state.updateWidget,
  );

  pi.registerTool({
    name: queryTool.name,
    label: queryTool.label,
    description: queryTool.description,
    parameters: queryTool.parameters,
    execute: safeToolExecute(queryTool.name, queryTool.execute),
  });

  const batchTool = buildRlmBatchTool(
    state.config,
    state.engine,
    state.callTree,
    state.costEstimator,
    state.store,
    state.warmTracker,
    () => state.enabled,
    state.activePhases,
    state.updateWidget,
  );

  pi.registerTool({
    name: batchTool.name,
    label: batchTool.label,
    description: batchTool.description,
    parameters: batchTool.parameters,
    execute: safeToolExecute(batchTool.name, batchTool.execute),
  });

  const peekTool = buildRlmPeekTool(state as any);

  pi.registerTool({
    name: peekTool.name,
    label: peekTool.label,
    description: peekTool.description,
    parameters: peekTool.parameters,
    execute: safeToolExecute(peekTool.name, peekTool.execute),
  });

  const searchTool = buildRlmSearchTool(state as any);

  pi.registerTool({
    name: searchTool.name,
    label: searchTool.label,
    description: searchTool.description,
    parameters: searchTool.parameters,
    execute: safeToolExecute(searchTool.name, searchTool.execute),
  });

  const statsTool = buildRlmStatsTool(state as any);

  pi.registerTool({
    name: statsTool.name,
    label: statsTool.label,
    description: statsTool.description,
    parameters: statsTool.parameters,
    execute: safeToolExecute(statsTool.name, statsTool.execute),
  });

  const ingestTool = buildRlmIngestTool(state as any);

  pi.registerTool({
    name: ingestTool.name,
    label: ingestTool.label,
    description: ingestTool.description,
    parameters: ingestTool.parameters,
    execute: safeToolExecute(ingestTool.name, ingestTool.execute),
  });
}

// Public exports
export {
  CallTree,
  ConcurrencyLimiter,
  CostEstimator,
  RecursiveEngine,
  resolveChildModel,
  isRateLimitError,
} from "./engine/index.js";
export * from "./types.js";
export { DEFAULT_CONFIG, mergeConfig } from "./config.js";
export { buildRlmQueryTool } from "./tools/query.js";
export { buildRlmBatchTool } from "./tools/batch.js";
export { safeToolExecute, safeHandler } from "./events.js";
export { ExternalStore, getRlmStoreDir } from "./store/store.js";
