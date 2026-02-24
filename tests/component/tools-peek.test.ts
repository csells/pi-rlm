/**
 * Component tests for rlm_peek tool.
 * Tests correct slicing of content, offset/length parameters,
 * continuation hints, missing object handling, warm tracking,
 * and disabled guard.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildRlmPeekTool } from "../../src/tools/peek.js";
import type { ExtensionContext, IExternalStore, ITrajectoryLogger, IWarmTracker } from "../../src/types.js";

describe("rlm_peek tool", () => {
  let mockStore: IExternalStore;
  let mockTrajectory: ITrajectoryLogger;
  let mockWarmTracker: IWarmTracker;
  let tool: any;

  beforeEach(() => {
    const longContent = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(100);

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
            content: longContent,
            tokenEstimate: 1500,
          },
        };
        return objects[id];
      }),
      getIndexEntry: vi.fn(),
      add: vi.fn(),
      getAllIds: vi.fn(),
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

    tool = buildRlmPeekTool({
      enabled: true,
      store: mockStore,
      trajectory: mockTrajectory,
      warmTracker: mockWarmTracker,
    });
  });

  describe("tool definition", () => {
    it("should have correct metadata", () => {
      expect(tool.name).toBe("rlm_peek");
      expect(tool.label).toBe("RLM Peek");
      expect(tool.description).toContain("retrieve");
    });

    it("should have proper parameter schema", () => {
      const props = tool.parameters.properties;
      expect(props.id).toBeDefined();
      expect(props.offset).toBeDefined();
      expect(props.length).toBeDefined();
    });
  });

  describe("execute", () => {
    it("should return error when RLM is disabled", async () => {
      const disabledTool = buildRlmPeekTool({
        enabled: false,
        store: mockStore,
        trajectory: mockTrajectory,
        warmTracker: mockWarmTracker,
      });

      const result = await disabledTool.execute(
        "call-1",
        { id: "obj-1" },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("disabled");
    });

    it("should return error when object ID is missing", async () => {
      const result = await tool.execute(
        "call-1",
        { id: "" },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Missing");
    });

    it("should return error when object ID not found", async () => {
      const result = await tool.execute(
        "call-1",
        { id: "nonexistent-id" },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    });

    it("should return correct slice of stored content", async () => {
      const result = await tool.execute(
        "call-1",
        { id: "obj-1", offset: 0, length: 10 },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("The quick");
    });

    it("should use default offset of 0 when not specified", async () => {
      const result = await tool.execute(
        "call-1",
        { id: "obj-1" },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toContain("The");
    });

    it("should use default length of 2000 when not specified", async () => {
      const result = await tool.execute(
        "call-1",
        { id: "obj-1" },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBeFalsy();
      // Should include the entire short content
      expect(result.content[0].text).toContain("lazy dog");
    });

    it("should select correct range with offset and length parameters", async () => {
      const result = await tool.execute(
        "call-1",
        { id: "obj-1", offset: 4, length: 5 },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBeFalsy();
      // Position 4-8 in "The quick brown..." should be "quick"
      expect(result.content[0].text).toContain("quick");
    });

    it("should handle offset beyond content length", async () => {
      const result = await tool.execute(
        "call-1",
        { id: "obj-1", offset: 1000, length: 100 },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBeFalsy();
      // Should return empty or very short content
      expect(result.content[0].text).toBeDefined();
    });

    it("should clamp negative offset to 0", async () => {
      const result = await tool.execute(
        "call-1",
        { id: "obj-1", offset: -10, length: 10 },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("The");
    });

    it("should include continuation hint when more content available", async () => {
      const result = await tool.execute(
        "call-1",
        { id: "obj-1", offset: 0, length: 5 },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toContain("continue");
    });

    it("should not include continuation hint when at end of content", async () => {
      const result = await tool.execute(
        "call-1",
        { id: "obj-1", offset: 0, length: 10000 },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      // Should not have "Use offset=" for continuation since we got all content
      expect(text).not.toContain("Use offset=");
    });

    it("should call warm tracker with object ID and toolCallId", async () => {
      await tool.execute(
        "call-1",
        { id: "obj-1" },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      expect(mockWarmTracker.markWarm).toHaveBeenCalledWith(["obj-1"]);
      expect(mockWarmTracker.markToolCallWarm).toHaveBeenCalledWith("call-1");
    });

    it("should show total character count in output", async () => {
      const result = await tool.execute(
        "call-1",
        { id: "obj-1", offset: 0, length: 10 },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      // Should mention total character count
      expect(text).toContain("total chars");
    });
  });

  describe("trajectory logging", () => {
    it("should log peek operation to trajectory", async () => {
      await tool.execute(
        "call-1",
        { id: "obj-1", offset: 10, length: 50 },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      expect(mockTrajectory.append).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "operation",
          operation: "peek",
          objectIds: ["obj-1"],
          details: expect.objectContaining({
            offset: 10,
            length: 50,
          }),
        }),
      );
    });
  });

  describe("details in result", () => {
    it("should include id, offset, length, and totalChars in details", async () => {
      const result = await tool.execute(
        "call-1",
        { id: "obj-1", offset: 5, length: 20 },
        undefined,
        undefined,
        { cwd: "/tmp", hasUI: false } as ExtensionContext,
      );

      expect(result.details).toEqual({
        id: "obj-1",
        offset: 5,
        length: 20,
        totalChars: expect.any(Number),
      });
    });
  });
});
