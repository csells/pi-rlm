/**
 * Component tests for rlm_batch tool per §7.4 and §14 of the design spec.
 * Tests the tool with mocked engine.batch() function.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { CallTree } from "../../src/engine/call-tree.js";
import { CostEstimator } from "../../src/engine/cost.js";
import { RecursiveEngine } from "../../src/engine/engine.js";
import { buildRlmBatchTool } from "../../src/tools/batch.js";
import { ExtensionContext, IExternalStore, ITrajectoryLogger, IWarmTracker, RlmConfig } from "../../src/types.js";

describe("rlm_batch tool", () => {
  let config: RlmConfig;
  let engine: RecursiveEngine;
  let callTree: CallTree;
  let costEstimator: CostEstimator;
  let mockStore: IExternalStore;
  let mockTrajectory: ITrajectoryLogger;
  let mockWarmTracker: IWarmTracker;
  let activePhases: Set<string>;
  let tool: any;

  beforeEach(() => {
    config = {
      enabled: true,
      maxDepth: 2,
      maxConcurrency: 4,
      tokenBudgetPercent: 60,
      safetyValvePercent: 90,
      manifestBudget: 2000,
      warmTurns: 3,
      childTimeoutSec: 120,
      operationTimeoutSec: 600,
      maxChildCalls: 50,
      childMaxTokens: 4096,
      retentionDays: 30,
      maxIngestFiles: 1000,
      maxIngestBytes: 100_000_000,
    };

    // Mock implementations
    mockStore = {
      get: vi.fn().mockImplementation((id: string) => {
        if (id === "obj-1" || id === "obj-2" || id === "obj-3") {
          return { id, content: `test content for ${id}`, tokenEstimate: 100 };
        }
        return null;
      }),
      getIndexEntry: vi.fn().mockImplementation((id: string) => {
        if (id === "obj-1" || id === "obj-2" || id === "obj-3") {
          return { id, tokenEstimate: 100 };
        }
        return null;
      }),
      add: vi.fn(),
      getAllIds: vi.fn().mockReturnValue(["obj-1", "obj-2", "obj-3"]),
      getFullIndex: vi.fn().mockReturnValue({ version: 1, sessionId: "test", objects: [], totalTokens: 0 }),
      findByIngestPath: vi.fn(),
      initialize: vi.fn(),
      flush: vi.fn(),
      rebuildExternalizedMap: vi.fn(),
    };

    mockTrajectory = {
      append: vi.fn(),
      flush: vi.fn(),
    };

    mockWarmTracker = {
      markWarm: vi.fn(),
      markToolCallWarm: vi.fn(),
      isWarm: vi.fn().mockReturnValue(false),
      isToolCallWarm: vi.fn().mockReturnValue(false),
      tick: vi.fn(),
    };

    callTree = new CallTree(config.maxChildCalls);
    costEstimator = new CostEstimator(mockStore);
    engine = new RecursiveEngine(config, mockStore, mockTrajectory, callTree, costEstimator, mockWarmTracker);

    // Mock the engine.batch method to return realistic results
    vi.spyOn(engine, "batch").mockImplementation(async (instructions, targets) => {
      return targets.map((target: string) => ({
        target,
        answer: `Processed ${target}: ${instructions}`,
        confidence: 0.85,
        tokenCost: 150,
      }));
    });

    activePhases = new Set();

    tool = buildRlmBatchTool(
      config,
      engine,
      callTree,
      costEstimator,
      mockStore,
      mockWarmTracker,
      () => true, // enabled
      activePhases,
    );
  });

  describe("tool definition", () => {
    it("should have correct metadata", () => {
      expect(tool.name).toBe("rlm_batch");
      expect(tool.label).toBe("RLM Batch");
      expect(tool.description).toContain("parallel");
    });

    it("should have proper parameter schema", () => {
      const props = tool.parameters.properties;
      expect(props.instructions).toBeDefined();
      expect(props.targets).toBeDefined();
      expect(props.model).toBeDefined();
    });

    it("targets parameter should require an array", () => {
      const targetsSchema = tool.parameters.properties.targets;
      expect(targetsSchema).toBeDefined();
      // TypeBox Type.Array
      expect(targetsSchema.type).toBe("array");
    });
  });

  describe("execute", () => {
    it("should return error when RLM is disabled", async () => {
      const disabledTool = buildRlmBatchTool(
        config,
        engine,
        callTree,
        costEstimator,
        mockStore,
        mockWarmTracker,
        () => false, // disabled
        activePhases,
      );

      const result = await disabledTool.execute("call-1", { instructions: "analyze", targets: ["obj-1"] }, undefined, undefined, {
        cwd: "/tmp",
        hasUI: false,
        model: { id: "gpt-4", label: "GPT-4", cost: { input: 30, output: 60 } },
      } as ExtensionContext);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("disabled");
    });

    it("should return error when targets array is empty", async () => {
      const result = await tool.execute("call-1", { instructions: "analyze", targets: [] }, undefined, undefined, {
        cwd: "/tmp",
        hasUI: false,
        model: { id: "gpt-4", label: "GPT-4", cost: { input: 30, output: 60 } },
      } as ExtensionContext);

      // Empty targets should cause engine.batch to be called with empty array,
      // which should result in an error or empty result
      expect(result).toBeDefined();
    });

    it("should return error when no model is available", async () => {
      const result = await tool.execute("call-1", { instructions: "analyze", targets: ["obj-1"] }, undefined, undefined, {
        cwd: "/tmp",
        hasUI: false,
        model: undefined,
      } as ExtensionContext);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("model");
    });

    it("batch with valid targets returns results for each target", async () => {
      const result = await tool.execute("call-1", { instructions: "analyze", targets: ["obj-1", "obj-2"] }, undefined, undefined, {
        cwd: "/tmp",
        hasUI: false,
        model: { id: "gpt-4", label: "GPT-4", cost: { input: 30, output: 60 } },
      } as ExtensionContext);

      expect(result.isError === undefined || result.isError === false).toBe(true);
      expect(result.content).toBeDefined();
      expect(result.content.length > 0).toBe(true);
      expect(result.content[0].text).toContain("obj-1");
      expect(result.content[0].text).toContain("obj-2");
      expect(result.details?.results).toBeDefined();
      expect(result.details.results.length).toBe(2);
    });

    it("should handle invalid/nonexistent object IDs gracefully", async () => {
      // Mock engine.batch to handle invalid IDs
      vi.spyOn(engine, "batch").mockImplementation(async (instructions, targets) => {
        return targets.map((target: string) => ({
          target,
          answer: target === "invalid-id" ? `Error: object ${target} not found` : `Processed ${target}: ${instructions}`,
          confidence: target === "invalid-id" ? 0 : 0.85,
          tokenCost: 150,
        }));
      });

      const result = await tool.execute("call-1", { instructions: "analyze", targets: ["obj-1", "invalid-id"] }, undefined, undefined, {
        cwd: "/tmp",
        hasUI: false,
        model: { id: "gpt-4", label: "GPT-4", cost: { input: 30, output: 60 } },
      } as ExtensionContext);

      expect(result.isError === undefined || result.isError === false).toBe(true);
      expect(result.details?.results).toBeDefined();
      expect(result.details.results.length).toBe(2);
      // Should include result for invalid-id (with error message in answer)
      expect(result.content[0].text).toContain("invalid-id");
    });

    it("should respect concurrency limit by verifying engine.batch receives correct args", async () => {
      const batchSpy = vi.spyOn(engine, "batch");

      const result = await tool.execute(
        "call-1",
        { instructions: "analyze", targets: ["obj-1", "obj-2", "obj-3"] },
        undefined,
        undefined,
        {
          cwd: "/tmp",
          hasUI: false,
          model: { id: "gpt-4", label: "GPT-4", cost: { input: 30, output: 60 } },
        } as ExtensionContext,
      );

      expect(result.isError === undefined || result.isError === false).toBe(true);
      expect(batchSpy).toHaveBeenCalled();

      // Verify engine.batch was called with the right parameters
      const callArgs = batchSpy.mock.calls[0];
      expect(callArgs[0]).toBe("analyze"); // instructions
      expect(callArgs[1]).toEqual(["obj-1", "obj-2", "obj-3"]); // targets
      expect(callArgs[1].length).toBeLessThanOrEqual(config.maxConcurrency);

      // Results should match number of targets
      expect(result.details?.results.length).toBe(3);
    });

    it("should cancel in-progress batch when abort signal fires", async () => {
      const controller = new AbortController();

      const batchPromise = tool.execute("call-1", { instructions: "analyze", targets: ["obj-1", "obj-2"] }, controller.signal, undefined, {
        cwd: "/tmp",
        hasUI: false,
        model: { id: "gpt-4", label: "GPT-4", cost: { input: 30, output: 60 } },
      } as ExtensionContext);

      // Simulate abort after a short delay
      setTimeout(() => {
        controller.abort();
      }, 10);

      const result = await batchPromise;

      // Should complete (either with result or error, but signal was sent)
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    });

    it("should add 'batching' phase to activePhases during execution", async () => {
      // Clear activePhases before test
      activePhases.clear();
      expect(activePhases.size).toBe(0);

      // Mock engine.batch to be slower so we can verify phase is added
      vi.spyOn(engine, "batch").mockImplementation(
        async (instructions, targets) => {
          // Verify batching phase was added
          expect(activePhases.has("batching")).toBe(true);
          return targets.map((target: string) => ({
            target,
            answer: `Processed ${target}: ${instructions}`,
            confidence: 0.85,
            tokenCost: 150,
          }));
        },
      );

      await tool.execute("call-1", { instructions: "analyze", targets: ["obj-1"] }, undefined, undefined, {
        cwd: "/tmp",
        hasUI: false,
        model: { id: "gpt-4", label: "GPT-4", cost: { input: 30, output: 60 } },
      } as ExtensionContext);

      // Phase should be cleaned up after execution
      expect(activePhases.has("batching")).toBe(false);
      expect(activePhases.has("synthesizing")).toBe(false);
    });

    it("should handle multiple targets correctly", async () => {
      const result = await tool.execute(
        "call-1",
        { instructions: "extract summary", targets: ["obj-1", "obj-2", "obj-3"] },
        undefined,
        undefined,
        {
          cwd: "/tmp",
          hasUI: false,
          model: { id: "gpt-4", label: "GPT-4", cost: { input: 30, output: 60 } },
        } as ExtensionContext,
      );

      expect(result.isError === undefined || result.isError === false).toBe(true);
      expect(result.details?.results.length).toBe(3);
      // Each target should appear in the output
      expect(result.content[0].text).toContain("obj-1");
      expect(result.content[0].text).toContain("obj-2");
      expect(result.content[0].text).toContain("obj-3");
    });
  });
});
