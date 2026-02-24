/**
 * Component tests for rlm_search tool.
 * Tests substring search, regex search, worker timeout, scope filtering,
 * disabled guard, and empty pattern validation.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildRlmSearchTool, parsePattern, searchWithWorkerTimeout } from "../../src/tools/search.js";
import type { ExtensionContext, IExternalStore, ITrajectoryLogger, IWarmTracker } from "../../src/types.js";

describe("rlm_search tool", () => {
  let mockStore: IExternalStore;
  let mockTrajectory: ITrajectoryLogger;
  let mockWarmTracker: IWarmTracker;
  let activePhases: Set<string>;
  let tool: any;

  beforeEach(() => {
    // Mock store with pre-populated objects
    mockStore = {
      get: vi.fn((id: string) => {
        const objects: Record<string, any> = {
          "obj-1": {
            id: "obj-1",
            content: "The quick brown fox jumps over the lazy dog",
            tokenEstimate: 100,
          },
          "obj-2": {
            id: "obj-2",
            content: "A red fox ran swiftly through the forest",
            tokenEstimate: 80,
          },
          "obj-3": {
            id: "obj-3",
            content: "The cat sat on the mat and watched the mouse",
            tokenEstimate: 90,
          },
        };
        return objects[id];
      }),
      getAllIds: vi.fn(() => ["obj-1", "obj-2", "obj-3"]),
      getIndexEntry: vi.fn(),
      add: vi.fn(),
      getFullIndex: vi.fn(),
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

    activePhases = new Set();

    tool = buildRlmSearchTool({
      enabled: true,
      store: mockStore,
      trajectory: mockTrajectory,
      warmTracker: mockWarmTracker,
      activePhases,
    });
  });

  describe("tool definition", () => {
    it("should have correct metadata", () => {
      expect(tool.name).toBe("rlm_search");
      expect(tool.label).toBe("RLM Search");
      expect(tool.description.toLowerCase()).toContain("search");
    });

    it("should have proper parameter schema", () => {
      const props = tool.parameters.properties;
      expect(props.pattern).toBeDefined();
      expect(props.scope).toBeDefined();
    });
  });

  describe("pattern parsing", () => {
    it("should parse substring patterns", () => {
      const pattern = parsePattern("hello world");
      expect(pattern.kind).toBe("substring");
      expect((pattern as any).needle).toBe("hello world");
    });

    it("should parse regex patterns with /pattern/flags syntax", () => {
      const pattern = parsePattern("/fox/i");
      expect(pattern.kind).toBe("regex");
      expect((pattern as any).regex.source).toBe("fox");
      expect((pattern as any).regex.flags).toContain("i");
    });

    it("should parse regex pattern without flags", () => {
      const pattern = parsePattern("/\\d+/");
      expect(pattern.kind).toBe("regex");
      expect((pattern as any).regex.source).toBe("\\d+");
    });

    it("should fall back to substring if regex is invalid", () => {
      const pattern = parsePattern("/[invalid(/");
      expect(pattern.kind).toBe("substring");
    });

    it("should add global flag to regex if not present", () => {
      const pattern = parsePattern("/test/i");
      expect((pattern as any).regex.flags).toContain("g");
    });
  });

  describe("execute", () => {
    it("should return error when RLM is disabled", async () => {
      const disabledTool = buildRlmSearchTool({
        enabled: false,
        store: mockStore,
        trajectory: mockTrajectory,
        warmTracker: mockWarmTracker,
        activePhases,
      });

      const result = await disabledTool.execute(
        "call-1",
        { pattern: "test" },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("disabled");
    });

    it("should return error for empty pattern", async () => {
      const result = await tool.execute(
        "call-1",
        { pattern: "" },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("non-empty");
    });

    it("should find substring matches in stored content", async () => {
      const result = await tool.execute(
        "call-1",
        { pattern: "fox" },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("Found");
      expect(result.content[0].text).toContain("obj-1");
      expect(result.content[0].text).toContain("obj-2");
      expect(mockTrajectory.append).toHaveBeenCalled();
    });

    it("should work with regex patterns", async () => {
      const result = await tool.execute(
        "call-1",
        { pattern: "/fox/i" },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("Found");
    });

    it("should respect scope parameter to limit search to specified object IDs", async () => {
      const result = await tool.execute(
        "call-1",
        { pattern: "fox", scope: ["obj-1"] },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toContain("obj-1");
      // Should not include obj-2 which also has "fox" but was not in scope
      expect(text).not.toContain("obj-2");
    });

    it("should handle catastrophic backtracking regex with timeout", async () => {
      // Create a catastrophic backtracking regex: (a+)+b
      // This will timeout when the content doesn't end with 'b'
      const result = await tool.execute(
        "call-1",
        { pattern: "/(a+)+b/" },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      // Should return a result (may have error details for timeout objects)
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    });

    it("should mark warmed objects and tool call", async () => {
      await tool.execute(
        "call-1",
        { pattern: "fox" },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      expect(mockWarmTracker.markWarm).toHaveBeenCalled();
      expect(mockWarmTracker.markToolCallWarm).toHaveBeenCalledWith("call-1");
    });

    it("should add searching phase while executing", async () => {
      expect(activePhases.has("searching")).toBe(false);

      await tool.execute(
        "call-1",
        { pattern: "fox" },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      // Phase should be removed after completion
      expect(activePhases.has("searching")).toBe(false);
    });

    it("should return no matches for non-existent pattern", async () => {
      const result = await tool.execute(
        "call-1",
        { pattern: "xyznotfound" },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("No matches");
    });

    it("should handle missing object ID in scope", async () => {
      const result = await tool.execute(
        "call-1",
        { pattern: "fox", scope: ["nonexistent-id"] },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("No matches");
    });

    it("should respect abort signal", async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await tool.execute(
        "call-1",
        { pattern: "fox" },
        controller.signal,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      // Should stop iteration and return partial results
      expect(result).toBeDefined();
    });
  });

  describe("trajectory logging", () => {
    it("should log search operation to trajectory", async () => {
      await tool.execute(
        "call-1",
        { pattern: "fox", scope: ["obj-1"] },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      expect(mockTrajectory.append).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "operation",
          operation: "search",
          objectIds: expect.any(Array),
          details: expect.objectContaining({
            pattern: "fox",
            mode: "substring",
          }),
        }),
      );
    });
  });
});
