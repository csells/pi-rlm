/**
 * rlm_query tool: Spawn a focused child LLM call on specific externalized objects.
 * Per §7.3 of the design spec.
 */

import { randomBytes } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { CallTree } from "../engine/call-tree.js";
import { CostEstimator } from "../engine/cost.js";
import { RecursiveEngine, resolveChildModel } from "../engine/engine.js";
import { ChildCallResult, ExtensionContext, IExternalStore, IWarmTracker, RlmConfig } from "../types.js";

export const RLM_QUERY_PARAMS_SCHEMA = Type.Object({
  instructions: Type.String({ description: "What to analyze or answer" }),
  target: Type.Union(
    [
      Type.String({ description: "Single object ID" }),
      Type.Array(Type.String(), { description: "Array of object IDs" }),
    ],
    { description: "Single object ID or array of object IDs" },
  ),
  model: Type.Optional(Type.String({ description: "Optional override child model (provider/model-id)" })),
});

/**
 * Build the rlm_query tool definition and executor.
 */
export function buildRlmQueryTool(
  config: RlmConfig,
  engine: RecursiveEngine,
  callTree: CallTree,
  costEstimator: CostEstimator,
  store: IExternalStore,
  warmTracker: IWarmTracker,
  enabled: () => boolean,
  activePhases: Set<string>,
  updateWidget?: (ctx: ExtensionContext) => void,
) {
  return {
    name: "rlm_query",
    label: "RLM Query",
    description: "Spawn a recursive child LLM call focused on specific externalized objects.",
    parameters: RLM_QUERY_PARAMS_SCHEMA,

    async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) {
      if (!enabled()) {
        return {
          content: [{ type: "text", text: "RLM is disabled. Use /rlm on to enable." }],
          isError: true,
        };
      }

      try {
        const targetIds = Array.isArray(params.target) ? params.target : [params.target];

        // Cost check (FR-9.5)
        const childModel = resolveChildModel(params.model, config, ctx);
        if (!childModel) {
          return {
            content: [{ type: "text", text: "Error: No model available for recursive call. Select a model first." }],
            isError: true,
          };
        }

        const estimate = costEstimator.estimateQuery(targetIds, config, childModel);

        // Confirm if many estimated calls
        if (estimate.estimatedCalls > 10) {
          if (ctx.hasUI && (ctx as any).ui?.confirm) {
            const ok = await (ctx as any).ui.confirm(
              "RLM Query",
              `This will spawn ~${estimate.estimatedCalls} child calls (est. $${estimate.estimatedCost.toFixed(4)}). Proceed?`,
            );
            if (!ok) {
              return { content: [{ type: "text", text: "Cancelled by user" }], isError: true };
            }
          } else {
            console.log(`[pi-rlm] rlm_query: est. ${estimate.estimatedCalls} calls, $${estimate.estimatedCost.toFixed(4)}`);
          }
        }

        activePhases.add("querying");
        updateWidget?.(ctx);

        // Register operation in CallTree
        const operationId = "rlm-query-" + randomBytes(4).toString("hex");
        const opController = callTree.registerOperation(operationId, estimate.estimatedCost);
        const opTimeout = setTimeout(() => opController.abort(), config.operationTimeoutSec * 1000);
        const onAbort = () => opController.abort();
        signal?.addEventListener("abort", onAbort, { once: true });

        try {
          const result = await engine.query(
            params.instructions,
            targetIds,
            null, // parentCallId
            0, // depth
            operationId,
            opController.signal,
            ctx,
            params.model,
          );

          // Format result
          const text = formatChildResult(result);

          return {
            content: [{ type: "text", text }],
            details: { result },
          };
        } finally {
          clearTimeout(opTimeout);
          signal?.removeEventListener("abort", onAbort);
          callTree.completeOperation(operationId);
          updateWidget?.(ctx);
        }
      } catch (err) {
        console.error("[pi-rlm] rlm_query error:", err);
        return {
          content: [{ type: "text", text: `RLM error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      } finally {
        activePhases.delete("querying");
        updateWidget?.(ctx);
      }
    },
  };
}

/**
 * Format a child result for display.
 */
function formatChildResult(result: ChildCallResult): string {
  return `**Confidence:** ${result.confidence}\n\n${result.answer}${
    result.evidence.length > 0 ? `\n\n**Evidence:**\n${result.evidence.map((e) => `- ${e}`).join("\n")}` : ""
  }`;
}
