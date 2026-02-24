/**
 * Unit tests for child rlm_search handler in engine.ts
 * Verifies regex timeout protection and substring fallback behavior.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as searchModule from "../../src/tools/search.js";
import { buildChildToolHandlers } from "../../src/engine/engine.js";
import type { IExternalStore, IWarmTracker, ITrajectoryLogger } from "../../src/types.js";

describe("child rlm_search handler", () => {
  let mockStore: IExternalStore;
  let mockWarmTracker: IWarmTracker;
  let mockTrajectory: ITrajectoryLogger;
  let handlers: Map<string, (args: Record<string, unknown>) => Promise<string>>;

  beforeEach(() => {
    // Mock store with test objects
    mockStore = {
      get: vi.fn((id: string) => {
        if (id === "obj-1") {
          return {
            id,
            type: "conversation" as const,
            description: "test object",
            createdAt: Date.now(),
            tokenEstimate: 100,
            source: { kind: "externalized" as const, fingerprint: "fp-1" },
            content: "The quick brown fox jumps over the lazy dog. The quick red fox.",
          };
        }
        if (id === "obj-2") {
          return {
            id,
            type: "conversation" as const,
            description: "test object 2",
            createdAt: Date.now(),
            tokenEstimate: 200,
            source: { kind: "externalized" as const, fingerprint: "fp-2" },
            content: "foo bar baz foo qux",
          };
        }
        return null;
      }),
      getAllIds: vi.fn(() => ["obj-1", "obj-2"]),
      getIndexEntry: vi.fn(),
      add: vi.fn(),
      getFullIndex: vi.fn(),
      findByIngestPath: vi.fn(),
      initialize: vi.fn(),
      flush: vi.fn(),
      rebuildExternalizedMap: vi.fn(),
      getExternalizedId: vi.fn(),
      addExternalized: vi.fn(),
    };

    mockWarmTracker = {
      markWarm: vi.fn(),
      markToolCallWarm: vi.fn(),
      isWarm: vi.fn(() => false),
      isToolCallWarm: vi.fn(() => false),
      tick: vi.fn(),
    };

    mockTrajectory = {
      append: vi.fn(),
      flush: vi.fn(),
    };

    // Build handlers with mocks
    handlers = buildChildToolHandlers(
      mockStore,
      {} as any, // engine
      {} as any, // callTree
      mockWarmTracker,
      0, // depth
      "test-operation-1",
      new AbortController().signal,
      {} as any, // ctx
      {
        enabled: true,
        maxDepth: 2,
        maxConcurrency: 1,
        tokenBudgetPercent: 80,
        safetyValvePercent: 10,
        manifestBudget: 10000,
        warmTurns: 3,
        childTimeoutSec: 30,
        operationTimeoutSec: 60,
        maxChildCalls: 10,
        childMaxTokens: 2000,
        retentionDays: 7,
        maxIngestFiles: 100,
        maxIngestBytes: 100000000,
      } as any,
    );
  });

  describe("substring search", () => {
    it("should find matches using indexOf for plain string patterns", async () => {
      const handler = handlers.get("rlm_search");
      expect(handler).toBeDefined();

      const result = await handler!({ pattern: "quick" });

      expect(result).toContain("Found 2 match(es)");
      expect(result).toContain("obj-1");
      expect(result).toContain("offset 4");
      expect(result).toContain("offset 57");
    });

    it("should handle empty substring results", async () => {
      const handler = handlers.get("rlm_search");
      const result = await handler!({ pattern: "nonexistent" });

      expect(result).toBe("No matches found.");
    });

    it("should respect scope parameter for substring search", async () => {
      const handler = handlers.get("rlm_search");
      const result = await handler!({ pattern: "foo", scope: ["obj-2"] });

      expect(result).toContain("Found 2 match(es)");
      expect(result).toContain("obj-2");
      expect(result).not.toContain("obj-1");
    });

    it("should mark warmed objects", async () => {
      const handler = handlers.get("rlm_search");
      await handler!({ pattern: "quick" });

      expect(mockWarmTracker.markWarm).toHaveBeenCalled();
    });

    it("should limit matches to 50 per object", async () => {
      // Mock store with many matches
      const manyMatches = "a ".repeat(60);
      mockStore.get = vi.fn((id: string) => ({
        id,
        type: "conversation" as const,
        description: "test",
        createdAt: Date.now(),
        tokenEstimate: 100,
        source: { kind: "externalized" as const, fingerprint: "fp" },
        content: manyMatches,
      }));

      const handler = handlers.get("rlm_search");
      const result = await handler!({ pattern: "a" });

      // Should stop at 50 matches
      expect(result).toContain("Found 50 match(es)");
    });
  });

  describe("regex search with worker timeout", () => {
    it("should call searchWithWorkerTimeout for regex patterns", async () => {
      // Spy on the searchWithWorkerTimeout function
      const originalSearchWithWorkerTimeout = searchModule.searchWithWorkerTimeout;
      const spy = vi.spyOn(searchModule, "searchWithWorkerTimeout");

      try {
        const handler = handlers.get("rlm_search");
        const result = await handler!({ pattern: "/quick/g" });

        // Verify searchWithWorkerTimeout was called
        expect(spy).toHaveBeenCalled();
        expect(result).toContain("Found");
      } finally {
        spy.mockRestore();
      }
    });

    it("should handle regex timeout errors", async () => {
      // Mock searchWithWorkerTimeout to return error match
      vi.spyOn(searchModule, "searchWithWorkerTimeout").mockResolvedValueOnce([
        {
          objectId: "obj-1",
          offset: 0,
          snippet: "",
          context: "",
          error: "Regex timed out after 5000ms",
        },
      ]);

      const handler = handlers.get("rlm_search");
      const result = await handler!({ pattern: "/evil.*?regex/g" });

      expect(result).toContain("Regex timed out after 5000ms");
    });

    it("should pass 5000ms timeout to searchWithWorkerTimeout", async () => {
      const spy = vi.spyOn(searchModule, "searchWithWorkerTimeout");

      try {
        const handler = handlers.get("rlm_search");
        await handler!({ pattern: "/test/g" });

        // Check that timeout was 5000ms
        expect(spy).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(RegExp),
          expect.any(String),
          5000,
        );
      } finally {
        spy.mockRestore();
      }
    });

    it("should handle regex worker errors gracefully", async () => {
      vi.spyOn(searchModule, "searchWithWorkerTimeout").mockResolvedValueOnce([
        {
          objectId: "obj-1",
          offset: 0,
          snippet: "",
          context: "",
          error: "Failed to create regex worker: Invalid regular expression",
        },
      ]);

      const handler = handlers.get("rlm_search");
      const result = await handler!({ pattern: "/[/g" });

      expect(result).toContain("Failed to create regex worker");
    });
  });

  describe("pattern parsing", () => {
    it("should parse /pattern/flags as regex", async () => {
      const handler = handlers.get("rlm_search");
      // This tests that parsePattern is called internally
      const result = await handler!({ pattern: "/quick/i" });

      // Should find matches with case-insensitive search
      expect(result).toContain("Found");
    });

    it("should parse plain text as substring", async () => {
      const handler = handlers.get("rlm_search");
      const result = await handler!({ pattern: "brown" });

      expect(result).toContain("brown");
      expect(result).toContain("obj-1");
    });

    it("should handle malformed regex by falling back to substring", async () => {
      const handler = handlers.get("rlm_search");
      // /[/ is invalid regex, should fall back to substring search
      const result = await handler!({ pattern: "/[/" });

      // Should return "No matches found" since "/[/" is not in the content
      expect(result).toBe("No matches found.");
    });
  });

  describe("output formatting", () => {
    it("should format substring matches with object ID and offset", async () => {
      const handler = handlers.get("rlm_search");
      const result = await handler!({ pattern: "quick" });

      expect(result).toMatch(/\*\*obj-1\*\*/);
      expect(result).toMatch(/offset \d+/);
      expect(result).toContain("...");
    });

    it("should format regex matches the same way as substring matches", async () => {
      const handler = handlers.get("rlm_search");
      const substringResult = await handler!({ pattern: "quick" });
      const regexResult = await handler!({ pattern: "/quick/g" });

      // Both should use the same format
      expect(substringResult).toMatch(/\*\*obj-1\*\*/);
      expect(regexResult).toMatch(/\*\*obj-1\*\*/);
    });

    it("should include context around matches", async () => {
      const handler = handlers.get("rlm_search");
      const result = await handler!({ pattern: "quick" });

      // Should include surrounding context
      expect(result).toContain("The");
      expect(result).toContain("brown");
      expect(result).toContain("fox");
    });
  });
});
