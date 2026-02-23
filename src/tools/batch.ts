/**
 * rlm_batch tool: Spawn parallel child LLM calls across multiple externalized objects.
 * Per §7.4 of the design spec.
 */

import { randomBytes } from "node:crypto";
import { CallTree } from "../engine/call-tree.js";
import { CostEstimator } from "../engine/cost.js";
import { RecursiveEngine, resolveChildModel } from "../engine/engine.js";
import { ChildCallResult, ExtensionContext, IExternalStore, IWarmTracker, RlmConfig } from "../types.js";

/**
 * Build the rlm_batch tool definition and executor.
 */
export function buildRlmBatchTool(
  config: RlmConfig,
  engine: RecursiveEngine,
  callTree: CallTree,
  costEstimator: CostEstimator,
  store: IExternalStore,
  warmTracker: IWarmTracker,
  enabled: () => boolean,
  activePhases: Set<string>,
) {
  return {
    name: "rlm_batch",
    label: "RLM Batch",
    description: "Spawn parallel child LLM calls across multiple externalized objects.",
    parameters: {
      type: "object",
      properties: {
        instructions: {
          type: "string",
          description: "What to analyze on each object",
        },
        targets: {
          type: "array",
          items: { type: "string" },
          description: "Array of object IDs",
        },
        model: {
          type: "string",
          description: "Optional override child model (provider/model-id)",
        },
      },
      required: ["instructions", "targets"],
    },

    async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) {
      if (!enabled()) {
        return {
          content: [{ type: "text", text: "RLM is disabled. Use /rlm on to enable." }],
          isError: true,
        };
      }

      try {
        const targets = params.targets || [];

        // Cost check (FR-9.5)
        const childModel = resolveChildModel(params.model, config, ctx);
        if (!childModel) {
          return {
            content: [{ type: "text", text: "Error: No model available for recursive call. Select a model first." }],
            isError: true,
          };
        }

        const estimate = costEstimator.estimateBatch(targets, config, childModel);

        // Confirm if many estimated calls
        if (estimate.estimatedCalls > 10) {
          if (ctx.hasUI && (ctx as any).ui?.confirm) {
            const ok = await (ctx as any).ui.confirm(
              "RLM Batch",
              `This will spawn ~${estimate.estimatedCalls} parallel calls (est. $${estimate.estimatedCost.toFixed(4)}). Proceed?`,
            );
            if (!ok) {
              return { content: [{ type: "text", text: "Cancelled by user" }], isError: true };
            }
          } else {
            console.log(`[pi-rlm] rlm_batch: est. ${estimate.estimatedCalls} calls, $${estimate.estimatedCost.toFixed(4)}`);
          }
        }

        activePhases.add("batching");

        // Register operation in CallTree — tool owns lifecycle (C1 fix)
        const operationId = "rlm-batch-" + randomBytes(4).toString("hex");
        const opController = callTree.registerOperation(operationId, estimate.estimatedCost);
        const opTimeout = setTimeout(() => opController.abort(), config.operationTimeoutSec * 1000);
        const onAbort = () => opController.abort();
        signal?.addEventListener("abort", onAbort, { once: true });

        try {
          // Pass all required args matching engine.batch() signature
          const results = await engine.batch(
            params.instructions,
            targets,
            null, // parentCallId
            0, // depth
            operationId,
            opController.signal,
            ctx,
            params.model,
          );

          activePhases.delete("batching");
          activePhases.add("synthesizing");

          // Format results
          const summary = results
            .map((r, i) => {
              const id = targets[i];
              return `### ${id}\n**Confidence:** ${r.confidence}\n${r.answer}`;
            })
            .join("\n\n");

          const text = summary;

          return {
            content: [{ type: "text", text }],
            details: { results },
          };
        } finally {
          clearTimeout(opTimeout);
          signal?.removeEventListener("abort", onAbort);
          callTree.completeOperation(operationId);
        }
      } catch (err) {
        console.error("[pi-rlm] rlm_batch error:", err);
        return {
          content: [{ type: "text", text: `RLM error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      } finally {
        activePhases.delete("batching");
        activePhases.delete("synthesizing");
      }
    },
  };
}
