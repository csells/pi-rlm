/**
 * CostEstimator: Estimates and tracks token costs for recursive calls.
 * Per §6.7 of the design.
 */

// Minimal types to avoid circular dependencies. Real type comes from pi-ai.
export interface Model {
  id: string;
  label: string;
  cost: {
    input: number; // $/Mtok (dollars per million tokens)
    output: number; // $/Mtok
  };
}

export interface StoreIndexEntry {
  id: string;
  tokenEstimate: number;
}

// Overhead per child call: system prompt (~600 tokens) + tool definitions (~300 tokens each)
const CHILD_OVERHEAD_TOKENS = 1000;

export class CostEstimator {
  constructor(private store: { getIndexEntry(id: string): StoreIndexEntry | null }) {}

  /**
   * Estimate cost of a single query operation.
   * rlm_query joins all targets into ONE child call.
   */
  estimateQuery(
    targetIds: string[],
    config: { maxDepth: number; childMaxTokens: number },
    model: Model,
  ): { estimatedCalls: number; estimatedCost: number } {
    // Sum input tokens from targets
    const totalInputTokens =
      targetIds.reduce((sum, id) => {
        const entry = this.store.getIndexEntry(id);
        return sum + (entry?.tokenEstimate ?? 0);
      }, 0) + CHILD_OVERHEAD_TOKENS;

    // model.cost.input and model.cost.output are in $/Mtok
    const costPerCall =
      (totalInputTokens * model.cost.input) / 1_000_000 +
      (config.childMaxTokens * model.cost.output) / 1_000_000;

    // Conservative: assume child may spawn 1 recursive call if depth allows
    const estimatedCalls = 1 + (config.maxDepth > 1 ? 1 : 0);

    return { estimatedCalls, estimatedCost: costPerCall * estimatedCalls };
  }

  /**
   * Estimate cost of a batch operation.
   * rlm_batch spawns ONE child per target.
   */
  estimateBatch(
    targetIds: string[],
    config: { maxDepth: number; childMaxTokens: number },
    model: Model,
  ): { estimatedCalls: number; estimatedCost: number } {
    // rlm_batch spawns ONE child per target
    const estimatedCalls = targetIds.length;
    const avgInputTokens =
      (targetIds.reduce((sum, id) => {
        const entry = this.store.getIndexEntry(id);
        return sum + (entry?.tokenEstimate ?? 0);
      }, 0) /
        Math.max(estimatedCalls, 1)) +
      CHILD_OVERHEAD_TOKENS;

    // model.cost.input and model.cost.output are in $/Mtok
    const costPerCall =
      (avgInputTokens * model.cost.input) / 1_000_000 +
      (config.childMaxTokens * model.cost.output) / 1_000_000;

    return {
      estimatedCalls,
      estimatedCost: estimatedCalls * costPerCall,
    };
  }

  /**
   * Update the actual cost on the CallTree's operation entry.
   */
  addCallCost(
    tokensIn: number,
    tokensOut: number,
    model: Model,
  ): number {
    // model.cost rates are in $/Mtok
    const cost = (tokensIn * model.cost.input) / 1_000_000 + (tokensOut * model.cost.output) / 1_000_000;
    return cost;
  }
}
