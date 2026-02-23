import { describe, it, expect, vi } from "vitest";
import {
  buildRlmSearchTool,
  parsePattern,
  searchWithWorkerTimeout,
} from "../../src/tools/search.js";

describe("rlm_search tool", () => {
  it("parsePattern returns substring mode for plain text", () => {
    const parsed = parsePattern("needle");
    expect(parsed.kind).toBe("substring");
    if (parsed.kind === "substring") {
      expect(parsed.needle).toBe("needle");
    }
  });

  it("parsePattern returns regex mode for /pattern/flags", () => {
    const parsed = parsePattern("/foo/i");
    expect(parsed.kind).toBe("regex");
    if (parsed.kind === "regex") {
      expect(parsed.regex.source).toBe("foo");
      expect(parsed.regex.flags.includes("i")).toBe(true);
      expect(parsed.regex.flags.includes("g")).toBe(true);
    }
  });

  it("searchWithWorkerTimeout returns regex matches", async () => {
    const matches = await searchWithWorkerTimeout("alpha beta alpha", /alpha/g, "obj-1", 2000);

    expect(matches.length).toBe(2);
    expect(matches[0].objectId).toBe("obj-1");
    expect(matches[0].offset).toBe(0);
  });

  it("returns disabled error when RLM is off", async () => {
    const tool = buildRlmSearchTool({
      enabled: false,
      store: { get: vi.fn(), getAllIds: vi.fn(() => []) } as any,
      trajectory: { append: vi.fn() } as any,
      warmTracker: { markWarm: vi.fn(), markToolCallWarm: vi.fn() } as any,
      activePhases: new Set<string>(),
    });

    const result = await tool.execute("call-1", { pattern: "x" }, undefined, undefined, {} as any);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("RLM is disabled");
  });

  it("performs substring search, respects scope, and caps at 50 matches", async () => {
    const manyAs = "a".repeat(80);
    const store = {
      getAllIds: vi.fn(() => ["obj-a", "obj-b"]),
      get: vi.fn((id: string) => {
        if (id === "obj-a") {
          return { id, content: manyAs };
        }
        if (id === "obj-b") {
          return { id, content: "zzz" };
        }
        return null;
      }),
    };

    const markWarm = vi.fn();
    const markToolCallWarm = vi.fn();
    const append = vi.fn();
    const phases = new Set<string>();

    const tool = buildRlmSearchTool({
      enabled: true,
      store: store as any,
      trajectory: { append } as any,
      warmTracker: { markWarm, markToolCallWarm } as any,
      activePhases: phases,
    });

    const result = await tool.execute(
      "call-2",
      { pattern: "a", scope: ["obj-a"] },
      undefined,
      undefined,
      {} as any,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Found 50 match(es)");
    expect(markToolCallWarm).toHaveBeenCalledWith("call-2");
    expect(markWarm).toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(1);
    expect(phases.has("searching")).toBe(false);
  });

  it("supports regex pattern mode through parsePattern", async () => {
    const store = {
      getAllIds: vi.fn(() => ["obj-1"]),
      get: vi.fn(() => ({ id: "obj-1", content: "foo bar foo" })),
    };

    const tool = buildRlmSearchTool({
      enabled: true,
      store: store as any,
      trajectory: { append: vi.fn() } as any,
      warmTracker: { markWarm: vi.fn(), markToolCallWarm: vi.fn() } as any,
      activePhases: new Set<string>(),
    });

    const result = await tool.execute("call-3", { pattern: "/foo/g" }, undefined, undefined, {} as any);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("obj-1");
  });
});
