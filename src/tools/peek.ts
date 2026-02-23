/**
 * rlm_peek tool: Retrieve a slice of an externalized object by ID.
 * Per §7.1 (FR-4.1).
 */

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ExtensionContext, IExternalStore, ITrajectoryLogger, IWarmTracker } from "../types.js";
import { disabledGuard, errorResult, successResult, type ToolResult } from "./guard.js";

export const RLM_PEEK_PARAMS_SCHEMA = Type.Object({
  id: Type.String({ description: "Object ID (e.g., rlm-obj-a1b2c3d4)" }),
  offset: Type.Optional(Type.Number({ description: "Character offset to start reading", default: 0 })),
  length: Type.Optional(Type.Number({ description: "Number of characters to read", default: 2000 })),
});

interface RlmPeekState {
  enabled: boolean;
  store: IExternalStore;
  trajectory: ITrajectoryLogger;
  warmTracker: IWarmTracker;
}

/**
 * Build the rlm_peek tool definition.
 */
export function buildRlmPeekTool(state: RlmPeekState) {
  return {
    name: "rlm_peek",
    label: "RLM Peek",
    description: "Retrieve a slice of an externalized object by ID and character offset.",
    parameters: RLM_PEEK_PARAMS_SCHEMA,

    async execute(
      toolCallId: string,
      params: { id: string; offset?: number; length?: number },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<ToolResult> {
      const guard = disabledGuard(state);
      if (guard) {
        return guard;
      }

      const startedAt = Date.now();

      try {
        const id = params?.id;
        if (!id) {
          return errorResult("Missing required parameter: id");
        }

        const obj = state.store.get(id);
        if (!obj) {
          return errorResult(`Object ${id} not found`);
        }

        const offset = Number.isFinite(params.offset) ? Math.max(0, Math.floor(params.offset!)) : 0;
        const length = Number.isFinite(params.length) ? Math.max(1, Math.floor(params.length!)) : 2000;

        const slice = obj.content.slice(offset, offset + length);

        // WarmTracker dual-tracking (§5.2.2)
        state.warmTracker.markWarm([id]);
        state.warmTracker.markToolCallWarm(toolCallId);

        state.trajectory.append({
          kind: "operation",
          operation: "peek",
          objectIds: [id],
          details: { offset, length },
          wallClockMs: Date.now() - startedAt,
          timestamp: Date.now(),
        });

        const truncation = truncateHead(slice, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });

        let text = truncation.content;

        if (truncation.truncated) {
          text += `\n[Output truncated. Object ${id} has ${obj.content.length} total chars.]`;
        }

        if (offset + length < obj.content.length) {
          text +=
            `\n[Showing ${offset}–${offset + length} of ${obj.content.length} chars. ` +
            `Use offset=${offset + length} to continue.]`;
        }

        return successResult(text, {
          id,
          offset,
          length,
          totalChars: obj.content.length,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`rlm_peek failed: ${message}`);
      }
    },
  };
}
