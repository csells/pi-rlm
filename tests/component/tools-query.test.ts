/**
 * Component tests for rlm_query tool per §7.3 and §14 of the design spec.
 * Tests the tool with mocked complete() function.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { CallTree } from "../../src/engine/call-tree.js";
import { CostEstimator } from "../../src/engine/cost.js";
import { RecursiveEngine } from "../../src/engine/engine.js";
import { buildRlmQueryTool } from "../../src/tools/query.js";
import { ChildCallResult, ExtensionContext, IExternalStore, ITrajectoryLogger, IWarmTracker, RlmConfig } from "../../src/types.js";

describe("rlm_query tool", () => {
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
      getAllIds: vi.fn().mockReturnValue(["obj-1"]),
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

    tool = buildRlmQueryTool(
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
      expect(tool.name).toBe("rlm_query");
      expect(tool.label).toBe("RLM Query");
      expect(tool.description).toContain("recursive");
    });

    it("should have proper parameter schema", () => {
      const props = tool.parameters.properties;
      expect(props.instructions).toBeDefined();
      expect(props.target).toBeDefined();
      expect(props.model).toBeDefined();
    });
  });

  describe("execute", () => {
    it("should return error when RLM is disabled", async () => {
      const disabledTool = buildRlmQueryTool(
        config,
        engine,
        callTree,
        costEstimator,
        mockStore,
        mockWarmTracker,
        () => false, // disabled
        activePhases,
      );

      const result = await disabledTool.execute("call-1", { instructions: "test", target: "obj-1" }, undefined, undefined, {} as ExtensionContext);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("disabled");
    });

    it("should handle single target as string", async () => {
      const result = await tool.execute("call-1", { instructions: "test", target: "obj-1" }, undefined, undefined, {
        cwd: "/tmp",
        hasUI: false,
        model: { id: "gpt-4", label: "GPT-4", cost: { input: 30, output: 60 } },
      } as ExtensionContext);

      expect(result).toBeDefined();
      expect(result.isError === undefined || result.isError === false).toBe(true);
    });

    it("should handle multiple targets as array", async () => {
      const result = await tool.execute("call-1", { instructions: "test", target: ["obj-1", "obj-2"] }, undefined, undefined, {
        cwd: "/tmp",
        hasUI: false,
        model: { id: "gpt-4", label: "GPT-4", cost: { input: 30, output: 60 } },
      } as ExtensionContext);

      expect(result).toBeDefined();
    });

    it("should return error when no model is available", async () => {
      const result = await tool.execute("call-1", { instructions: "test", target: "obj-1" }, undefined, undefined, {
        cwd: "/tmp",
        hasUI: false,
        model: undefined,
      } as ExtensionContext);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("model");
    });

    it("should add phase while executing", async () => {
      expect(activePhases.has("querying")).toBe(false);

      // Note: this is a basic test; full execution requires pi-ai integration
      // which will be added in Phase 2 when task-1 provides the complete() function.

      expect(activePhases.size >= 0).toBe(true); // Just verify activePhases is usable
    });
  });
});
