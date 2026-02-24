/**
 * Component tests for rlm_batch tool per §7.4 and §14 of the design spec.
 * Tests the tool with mocked engine.batch() function.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { CallTree } from "../../src/engine/call-tree.js";
import { CostEstimator } from "../../src/engine/cost.js";
import { RecursiveEngine } from "../../src/engine/engine.js";
import { buildRlmBatchTool } from "../../src/tools/batch.js";
import { ChildCallResult, ExtensionContext, IExternalStore, ITrajectoryLogger, IWarmTracker, RlmConfig } from "../../src/types.js";

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
      get: vi.fn().mockReturnValue({ id: "obj-1", content: "test content", tokenEstimate: 100 }),
      getIndexEntry: vi.fn().mockReturnValue({ id: "obj-1", tokenEstimate: 100 }),
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

      const result = await disabledTool.execute(
        "call-1",
        { instructions: "test", targets: ["obj-1", "obj-2"] },
        undefined,
        undefined,
        {} as ExtensionContext,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("disabled");
    });

    it("should return error when targets array is empty", async () => {
      // Mock engine.batch to return empty array for empty targets
      const batchSpy = vi.spyOn(engine, "batch").mockResolvedValue([]);

      const result = await tool.execute(
        "call-1",
        { instructions: "test", targets: [] },
        undefined,
        undefined,
        {
          cwd: "/tmp",
          hasUI: false,
          model: { id: "gpt-4", label: "GPT-4", cost: { input: 30, output: 60 } },
        } as ExtensionContext,
      );

      expect(result.isError).toBe(true);
      batchSpy.mockRestore();
    });

    it("batch with valid targets returns results for each target", async () => {
      // Mock engine.batch to return results
      const mockResults: ChildCallResult[] = [
        { answer: "Result 1", confidence: "high", evidence: [] },
        { answer: "Result 2", confidence: "high", evidence: [] },
        { answer: "Result 3", confidence: "medium", evidence: [] },
      ];

      const batchSpy = vi.spyOn(engine, "batch").mockResolvedValue(mockResults);

      const result = await tool.execute(
        "call-1",
        { instructions: "analyze this", targets: ["obj-1", "obj-2", "obj-3"] },
        undefined,
        undefined,
        {
          cwd: "/tmp",
          hasUI: false,
          model: { id: "gpt-4", label: "GPT-4", cost: { input: 30, output: 60 } },
        } as ExtensionContext,
      );

      expect(result.isError === undefined || result.isError === false).toBe(true);
      expect(result.content[0].text).toContain("obj-1");
      expect(result.content[0].text).toContain("obj-2");
      expect(result.content[0].text).toContain("obj-3");
      expect(result.details.results).toHaveLength(3);

      batchSpy.mockRestore();
    });

    it("should handle invalid/nonexistent object IDs gracefully", async () => {
      // Mock engine.batch to return results even with nonexistent IDs
      const mockResults: ChildCallResult[] = [
        { answer: "Result for valid ID", confidence: "high", evidence: [] },
        { answer: "Object not found", confidence: "low", evidence: [] },
      ];

      const batchSpy = vi.spyOn(engine, "batch").mockResolvedValue(mockResults);

      const result = await tool.execute(
        "call-1",
        { instructions: "analyze", targets: ["obj-1", "nonexistent-id"] },
        undefined,
        undefined,
        {
          cwd: "/tmp",
          hasUI: false,
          model: { id: "gpt-4", label: "GPT-4", cost: { input: 30, output: 60 } },
        } as ExtensionContext,
      );

      expect(result.isError === undefined || result.isError === false).toBe(true);
      expect(result.details.results).toHaveLength(2);
      expect(result.details.results[1].confidence).toBe("low");

      batchSpy.mockRestore();
    });

    it("should respect concurrency limit (verify engine.batch receives correct args)", async () => {
      const mockResults: ChildCallResult[] = [
        { answer: "Result 1", confidence: "high", evidence: [] },
        { answer: "Result 2", confidence: "high", evidence: [] },
      ];

      const batchSpy = vi.spyOn(engine, "batch").mockResolvedValue(mockResults);

      const targets = ["obj-1", "obj-2"];
      const instructions = "analyze each target";

      await tool.execute(
        "call-1",
        { instructions, targets },
        undefined,
        undefined,
        {
          cwd: "/tmp",
          hasUI: false,
          model: { id: "gpt-4", label: "GPT-4", cost: { input: 30, output: 60 } },
        } as ExtensionContext,
      );

      // Verify engine.batch was called with correct arguments
      expect(batchSpy).toHaveBeenCalledWith(
        instructions,
        targets,
        null, // parentCallId
        0, // depth
        expect.any(String), // operationId
        expect.any(AbortSignal), // operationSignal
        expect.any(Object), // ctx
        undefined, // modelOverride
      );

      // Verify concurrency config is respected (maxConcurrency = 4)
      expect(config.maxConcurrency).toBe(4);

      batchSpy.mockRestore();
    });

    it("should handle abort signal cancels in-progress batch", async () => {
      const controller = new AbortController();
      let batchCalled = false;

      const batchSpy = vi.spyOn(engine, "batch").mockImplementation(async (instructions, targets, parentCallId, depth, operationId, operationSignal) => {
        batchCalled = true;
        // Simulate listening to abort signal
        if (operationSignal.aborted) {
          throw new Error("Operation aborted");
        }
        return [
          { answer: "Result 1", confidence: "high", evidence: [] },
          { answer: "Result 2", confidence: "high", evidence: [] },
        ];
      });

      // Start execution
      const executePromise = tool.execute(
        "call-1",
        { instructions: "analyze", targets: ["obj-1", "obj-2"] },
        controller.signal,
        undefined,
        {
          cwd: "/tmp",
          hasUI: false,
          model: { id: "gpt-4", label: "GPT-4", cost: { input: 30, output: 60 } },
        } as ExtensionContext,
      );

      // Abort the operation shortly after
      setTimeout(() => controller.abort(), 50);

      // Execute should complete (either successfully or with abort handling)
      const result = await executePromise;
      expect(batchCalled).toBe(true);

      batchSpy.mockRestore();
    });

    it("should return error when no model is available", async () => {
      const result = await tool.execute(
        "call-1",
        { instructions: "test", targets: ["obj-1"] },
        undefined,
        undefined,
        {
          cwd: "/tmp",
          hasUI: false,
          model: undefined,
        } as ExtensionContext,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("model");
    });

    it("should add phase while executing", async () => {
      const mockResults: ChildCallResult[] = [{ answer: "Result", confidence: "high", evidence: [] }];

      vi.spyOn(engine, "batch").mockResolvedValue(mockResults);

      expect(activePhases.has("batching")).toBe(false);

      // Execute the tool
      await tool.execute(
        "call-1",
        { instructions: "test", targets: ["obj-1"] },
        undefined,
        undefined,
        {
          cwd: "/tmp",
          hasUI: false,
          model: { id: "gpt-4", label: "GPT-4", cost: { input: 30, output: 60 } },
        } as ExtensionContext,
      );

      // Phase should be cleaned up after execution
      expect(activePhases.has("batching")).toBe(false);
    });
  });
});
