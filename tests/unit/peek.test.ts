import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildRlmPeekTool } from "../../src/tools/peek.js";

describe("rlm_peek tool", () => {
  const toolCallId = "tool-call-1";
  let trajectory: { append: ReturnType<typeof vi.fn> };
  let warmTracker: { markWarm: ReturnType<typeof vi.fn>; markToolCallWarm: ReturnType<typeof vi.fn> };
  let store: { get: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    trajectory = { append: vi.fn() };
    warmTracker = {
      markWarm: vi.fn(),
      markToolCallWarm: vi.fn(),
    };
    store = {
      get: vi.fn(),
    };
  });

  it("returns disabled error when RLM is off", async () => {
    const tool = buildRlmPeekTool({
      enabled: false,
      store: store as any,
      trajectory: trajectory as any,
      warmTracker: warmTracker as any,
    });

    const result = await tool.execute(toolCallId, { id: "obj-1" }, undefined, undefined, {} as any);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("RLM is disabled");
  });

  it("returns object-not-found error", async () => {
    store.get.mockReturnValue(null);

    const tool = buildRlmPeekTool({
      enabled: true,
      store: store as any,
      trajectory: trajectory as any,
      warmTracker: warmTracker as any,
    });

    const result = await tool.execute(toolCallId, { id: "missing" }, undefined, undefined, {} as any);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Object missing not found");
  });

  it("returns requested slice and continuation hint", async () => {
    store.get.mockReturnValue({
      id: "obj-1",
      content: "abcdefghijklmnopqrstuvwxyz",
    });

    const tool = buildRlmPeekTool({
      enabled: true,
      store: store as any,
      trajectory: trajectory as any,
      warmTracker: warmTracker as any,
    });

    const result = await tool.execute(
      toolCallId,
      { id: "obj-1", offset: 2, length: 5 },
      undefined,
      undefined,
      {} as any,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("cdefg");
    expect(result.content[0].text).toContain("Use offset=7 to continue");
  });

  it("marks source object and tool call as warm", async () => {
    store.get.mockReturnValue({
      id: "obj-1",
      content: "hello world",
    });

    const tool = buildRlmPeekTool({
      enabled: true,
      store: store as any,
      trajectory: trajectory as any,
      warmTracker: warmTracker as any,
    });

    await tool.execute(toolCallId, { id: "obj-1" }, undefined, undefined, {} as any);

    expect(warmTracker.markWarm).toHaveBeenCalledWith(["obj-1"]);
    expect(warmTracker.markToolCallWarm).toHaveBeenCalledWith(toolCallId);
    expect(trajectory.append).toHaveBeenCalledTimes(1);
  });
});
