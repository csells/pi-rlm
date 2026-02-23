/**
 * rlm_stats tool: current RLM state summary.
 * Per §7.6 (FR-4.5).
 */

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ExtensionContext, IExternalStore, ITrajectoryLogger } from "../types.js";
import type { CallTree } from "../engine/call-tree.js";
import { disabledGuard, errorResult, successResult, type ToolResult } from "./guard.js";

export const RLM_STATS_PARAMS_SCHEMA = Type.Object({});

interface RlmStatsState {
  enabled: boolean;
  store: IExternalStore;
  trajectory: ITrajectoryLogger;
  callTree: CallTree;
  activePhases: Set<string>;
}

export function buildRlmStatsTool(state: RlmStatsState) {
  return {
    name: "rlm_stats",
    label: "RLM Stats",
    description: "Show current RLM state: store size, context usage, phases, and recursion depth.",
    parameters: RLM_STATS_PARAMS_SCHEMA,

    async execute(
      _toolCallId: string,
      _params: Record<string, never>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<ToolResult> {
      const guard = disabledGuard(state);
      if (guard) {
        return guard;
      }

      const startedAt = Date.now();

      try {
        const index = state.store.getFullIndex();
        const usage = ctx.getContextUsage();
        const activeCalls = state.callTree.getActive();
        const recursionDepth = state.callTree.maxActiveDepth();
        const activePhases = [...state.activePhases];

        const lines = [
          "RLM Status",
          `Store objects: ${index.objects.length}`,
          `Store token estimate: ${index.totalTokens.toLocaleString()}`,
          `Store size (bytes): ${estimateStoreBytes(index).toLocaleString()}`,
          `Working context usage: ${formatContextUsage(usage)}`,
          `Active phases: ${activePhases.length > 0 ? activePhases.join(", ") : "none"}`,
          `Active child calls: ${activeCalls.length}`,
          `Recursion depth: ${recursionDepth}`,
        ];

        state.trajectory.append({
          kind: "operation",
          operation: "stats",
          objectIds: [],
          details: {
            objectCount: index.objects.length,
            totalTokens: index.totalTokens,
            activeCalls: activeCalls.length,
            recursionDepth,
            activePhases,
          },
          wallClockMs: Date.now() - startedAt,
          timestamp: Date.now(),
        });

        const text = lines.join("\n");
        const truncation = truncateHead(text, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });

        return successResult(truncation.content, {
          objectCount: index.objects.length,
          totalTokens: index.totalTokens,
          activeCalls: activeCalls.length,
          recursionDepth,
          activePhases,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`rlm_stats failed: ${message}`);
      }
    },
  };
}

function estimateStoreBytes(index: ReturnType<IExternalStore["getFullIndex"]>): number {
  return index.objects.reduce((sum, obj) => {
    const metaBytes = Buffer.byteLength(
      JSON.stringify({
        id: obj.id,
        type: obj.type,
        description: obj.description,
        tokenEstimate: obj.tokenEstimate,
      }),
      "utf8",
    );
    return sum + Math.max(obj.byteLength, metaBytes);
  }, 0);
}

function formatContextUsage(
  usage: ReturnType<ExtensionContext["getContextUsage"]>,
): string {
  if (!usage || usage.tokens === null) {
    return "unknown";
  }

  const base = `${usage.tokens.toLocaleString()} tokens`;

  if (!usage.contextWindow || usage.contextWindow <= 0) {
    return base;
  }

  const pct = Math.round((usage.tokens / usage.contextWindow) * 100);
  return `${base} / ${usage.contextWindow.toLocaleString()} (${pct}%)`;
}
