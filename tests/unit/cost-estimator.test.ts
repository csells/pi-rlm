/**
 * Unit tests for CostEstimator per §6.7 of the design spec.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { CostEstimator, Model } from "../../src/engine/cost.js";
import { StoreIndexEntry } from "../../src/types.js";

describe("CostEstimator", () => {
  let estimator: CostEstimator;
  let mockStore: { getIndexEntry(id: string): StoreIndexEntry | null };
  let mockModel: Model;

  beforeEach(() => {
    // Mock store with some test objects
    mockStore = {
      getIndexEntry: (id: string) => {
        const entries: Record<string, StoreIndexEntry> = {
          "obj-1": {
            id: "obj-1",
            type: "conversation",
            description: "Test 1",
            tokenEstimate: 1000,
            createdAt: Date.now(),
            byteOffset: 0,
            byteLength: 100,
          },
          "obj-2": {
            id: "obj-2",
            type: "file",
            description: "Test 2",
            tokenEstimate: 2000,
            createdAt: Date.now(),
            byteOffset: 100,
            byteLength: 200,
          },
          "obj-3": {
            id: "obj-3",
            type: "tool_output",
            description: "Test 3",
            tokenEstimate: 500,
            createdAt: Date.now(),
            byteOffset: 300,
            byteLength: 50,
          },
        };
        return entries[id] ?? null;
      },
    };

    estimator = new CostEstimator(mockStore);

    // Mock model with typical Claude pricing
    mockModel = {
      id: "claude-3-5-sonnet-20241022",
      label: "Claude 3.5 Sonnet",
      cost: {
        input: 3.0, // $3/Mtok
        output: 15.0, // $15/Mtok
      },
    };
  });

  describe("estimateQuery", () => {
    it("should estimate cost for a single query", () => {
      const estimate = estimator.estimateQuery(["obj-1"], { maxDepth: 2, childMaxTokens: 4096 }, mockModel);

      // Should include object tokens + overhead + max output tokens
      expect(estimate.estimatedCalls).toBeGreaterThan(0);
      expect(estimate.estimatedCost).toBeGreaterThan(0);
    });

    it("should estimate higher cost for multiple targets", () => {
      const singleEstimate = estimator.estimateQuery(["obj-1"], { maxDepth: 2, childMaxTokens: 4096 }, mockModel);
      const multiEstimate = estimator.estimateQuery(["obj-1", "obj-2"], { maxDepth: 2, childMaxTokens: 4096 }, mockModel);

      expect(multiEstimate.estimatedCost).toBeGreaterThan(singleEstimate.estimatedCost);
    });

    it("should account for recursion depth in estimate", () => {
      const shallow = estimator.estimateQuery(["obj-1"], { maxDepth: 1, childMaxTokens: 4096 }, mockModel);
      const deep = estimator.estimateQuery(["obj-1"], { maxDepth: 2, childMaxTokens: 4096 }, mockModel);

      // Deeper trees may estimate more calls due to recursion
      expect(deep.estimatedCalls).toBeGreaterThanOrEqual(shallow.estimatedCalls);
    });

    it("should handle missing objects gracefully", () => {
      const estimate = estimator.estimateQuery(["non-existent"], { maxDepth: 2, childMaxTokens: 4096 }, mockModel);

      // Should still return a reasonable estimate (just overhead)
      expect(estimate.estimatedCalls).toBeGreaterThan(0);
      expect(estimate.estimatedCost).toBeGreaterThan(0);
    });
  });

  describe("estimateBatch", () => {
    it("should estimate cost for batch operation", () => {
      const estimate = estimator.estimateBatch(["obj-1", "obj-2"], { maxDepth: 2, childMaxTokens: 4096 }, mockModel);

      // Should have one call per target (plus overhead)
      expect(estimate.estimatedCalls).toBe(2);
      expect(estimate.estimatedCost).toBeGreaterThan(0);
    });

    it("should scale cost linearly with target count", () => {
      const single = estimator.estimateBatch(["obj-1"], { maxDepth: 2, childMaxTokens: 4096 }, mockModel);
      const double = estimator.estimateBatch(["obj-1", "obj-2"], { maxDepth: 2, childMaxTokens: 4096 }, mockModel);
      const triple = estimator.estimateBatch(
        ["obj-1", "obj-2", "obj-3"],
        { maxDepth: 2, childMaxTokens: 4096 },
        mockModel,
      );

      expect(double.estimatedCalls).toBe(2);
      expect(triple.estimatedCalls).toBe(3);
    });

    it("should use average token count across targets", () => {
      // obj-1: 1000, obj-2: 2000, obj-3: 500
      // Average: 1166.67
      const estimate = estimator.estimateBatch(["obj-1", "obj-2", "obj-3"], { maxDepth: 2, childMaxTokens: 4096 }, mockModel);

      // Cost should be based on average input tokens + max output tokens
      expect(estimate.estimatedCalls).toBe(3);
      expect(estimate.estimatedCost).toBeGreaterThan(0);
    });

    it("should handle empty target list", () => {
      const estimate = estimator.estimateBatch([], { maxDepth: 2, childMaxTokens: 4096 }, mockModel);

      expect(estimate.estimatedCalls).toBe(0);
      expect(estimate.estimatedCost).toBe(0);
    });
  });

  describe("addCallCost", () => {
    it("should calculate cost from tokens and model rates", () => {
      const tokensIn = 1000;
      const tokensOut = 500;

      // $3/Mtok input, $15/Mtok output
      // Cost = (1000 * 3 / 1_000_000) + (500 * 15 / 1_000_000)
      //      = 0.003 + 0.0075 = 0.0105
      const cost = estimator.addCallCost(tokensIn, tokensOut, mockModel);

      expect(cost).toBe(0.0105);
    });

    it("should handle zero tokens", () => {
      const cost = estimator.addCallCost(0, 0, mockModel);
      expect(cost).toBe(0);
    });

    it("should handle free models (zero cost)", () => {
      const freeModel: Model = {
        id: "test-free",
        label: "Free Model",
        cost: { input: 0, output: 0 },
      };

      const cost = estimator.addCallCost(1000, 500, freeModel);
      expect(cost).toBe(0);
    });

    it("should scale correctly for large token counts", () => {
      const tokensIn = 1_000_000; // 1M tokens
      const tokensOut = 500_000; // 500K tokens

      // $3/Mtok input, $15/Mtok output
      // Cost = (1_000_000 * 3 / 1_000_000) + (500_000 * 15 / 1_000_000)
      //      = 3 + 7.5 = 10.5
      const cost = estimator.addCallCost(tokensIn, tokensOut, mockModel);

      expect(cost).toBe(10.5);
    });
  });
});
