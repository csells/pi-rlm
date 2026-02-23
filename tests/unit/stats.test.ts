import { describe, it, expect, vi } from "vitest";
import { CallTree } from "../../src/engine/call-tree.js";
import { buildRlmStatsTool } from "../../src/tools/stats.js";

describe("rlm_stats tool", () => {
  it("returns disabled error when RLM is off", async () => {
    const tool = buildRlmStatsTool({
      enabled: false,
      store: { getFullIndex: vi.fn() } as any,
      trajectory: { append: vi.fn() } as any,
      callTree: new CallTree(),
      activePhases: new Set<string>(),
    });

    const result = await tool.execute("call-1", {}, undefined, undefined, {} as any);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("RLM is disabled");
  });

  it("reports store size, object count, context usage, phases, and recursion depth", async () => {
    const callTree = new CallTree();
    callTree.registerOperation("op-1", 0);
    callTree.registerCall({
      callId: "root",
      parentCallId: null,
      operationId: "op-1",
      depth: 0,
      model: "test",
      query: "q",
      status: "running",
      startTime: Date.now(),
      tokensIn: 0,
      tokensOut: 0,
    });
    callTree.registerCall({
      callId: "child",
      parentCallId: "root",
      operationId: "op-1",
      depth: 1,
      model: "test",
      query: "q2",
      status: "running",
      startTime: Date.now(),
      tokensIn: 0,
      tokensOut: 0,
    });

    const append = vi.fn();

    const tool = buildRlmStatsTool({
      enabled: true,
      store: {
        getFullIndex: vi.fn(() => ({
          version: 1,
          sessionId: "s1",
          totalTokens: 1234,
          objects: [
            {
              id: "obj-1",
              type: "conversation",
              description: "d",
              tokenEstimate: 100,
              createdAt: Date.now(),
              byteOffset: 0,
              byteLength: 64,
            },
            {
              id: "obj-2",
              type: "file",
              description: "f",
              tokenEstimate: 200,
              createdAt: Date.now(),
              byteOffset: 64,
              byteLength: 128,
            },
          ],
        })),
      } as any,
      trajectory: { append } as any,
      callTree,
      activePhases: new Set<string>(["searching", "querying"]),
    });

    const ctx = {
      getContextUsage: () => ({ tokens: 5000, contextWindow: 10000 }),
    };

    const result = await tool.execute("call-2", {}, undefined, undefined, ctx as any);

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("Store objects: 2");
    expect(text).toMatch(/Store size \(bytes\): \d+/);
    expect(text).toContain("Working context usage: 5,000 tokens / 10,000 (50%)");
    expect(text).toContain("Active phases: searching, querying");
    expect(text).toContain("Recursion depth: 1");
    expect(append).toHaveBeenCalledTimes(1);
  });
});
