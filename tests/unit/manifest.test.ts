/**
 * Unit tests for ManifestBuilder.
 * Per §14 (Testing Strategy) and §3.3 of the design spec.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ManifestBuilder } from "../../src/context/manifest.js";
import { StoreIndexEntry, StoreIndex, IExternalStore } from "../../src/types.js";

/**
 * Mock implementation of IExternalStore for testing.
 */
class MockExternalStore implements IExternalStore {
  private index: StoreIndex;

  constructor(entries: StoreIndexEntry[] = []) {
    this.index = {
      version: 1,
      sessionId: "test-session",
      objects: entries,
      totalTokens: entries.reduce((sum, e) => sum + e.tokenEstimate, 0),
    };
  }

  get(id: string) {
    return null;
  }

  getIndexEntry(id: string) {
    return this.index.objects.find((e) => e.id === id) || null;
  }

  add() {
    throw new Error("Not implemented");
  }

  getAllIds() {
    return this.index.objects.map((e) => e.id);
  }

  getFullIndex() {
    return this.index;
  }

  findByIngestPath() {
    return null;
  }

  async initialize() {
    // No-op for mock
  }

  async flush() {
    // No-op for mock
  }

  rebuildExternalizedMap() {
    // No-op for mock
  }
}

describe("ManifestBuilder", () => {
  let store: MockExternalStore;
  let builder: ManifestBuilder;

  beforeEach(() => {
    store = new MockExternalStore();
    builder = new ManifestBuilder(store);
  });

  describe("build", () => {
    it("should generate manifest header for empty store", () => {
      const manifest = builder.build(500);
      expect(manifest).toContain("No externalized content yet");
    });

    it("should generate manifest table with entries", () => {
      store = new MockExternalStore([
        {
          id: "rlm-obj-001",
          type: "file",
          description: "src/auth.ts (full file)",
          tokenEstimate: 2340,
          createdAt: 1700000000000,
          byteOffset: 0,
          byteLength: 100,
        },
      ]);
      builder = new ManifestBuilder(store);
      const manifest = builder.build(500);
      expect(manifest).toContain("rlm-obj-001");
      expect(manifest).toContain("file");
      expect(manifest).toContain("2340");
      expect(manifest).toContain("src/auth.ts");
    });

    it("should sort entries by createdAt descending (most recent first)", () => {
      store = new MockExternalStore([
        {
          id: "rlm-obj-001",
          type: "conversation",
          description: "First message",
          tokenEstimate: 100,
          createdAt: 1700000000000,
          byteOffset: 0,
          byteLength: 50,
        },
        {
          id: "rlm-obj-002",
          type: "conversation",
          description: "Second message",
          tokenEstimate: 150,
          createdAt: 1700000001000, // More recent
          byteOffset: 50,
          byteLength: 75,
        },
      ]);
      builder = new ManifestBuilder(store);
      const manifest = builder.build(500);
      // Check that rlm-obj-002 appears before rlm-obj-001 in the manifest
      const idx1 = manifest.indexOf("rlm-obj-001");
      const idx2 = manifest.indexOf("rlm-obj-002");
      expect(idx2).toBeLessThan(idx1);
    });

    it("should include manifest header and footer", () => {
      store = new MockExternalStore([
        {
          id: "rlm-obj-001",
          type: "file",
          description: "Test file",
          tokenEstimate: 100,
          createdAt: 1700000000000,
          byteOffset: 0,
          byteLength: 50,
        },
      ]);
      builder = new ManifestBuilder(store);
      const manifest = builder.build(500);
      expect(manifest).toContain("RLM External Context");
      expect(manifest).toContain("Total:");
      expect(manifest).toContain("objects");
      expect(manifest).toContain("tokens externalized");
    });

    it("should include correct total count", () => {
      store = new MockExternalStore([
        {
          id: "rlm-obj-001",
          type: "file",
          description: "File 1",
          tokenEstimate: 100,
          createdAt: 1700000000000,
          byteOffset: 0,
          byteLength: 50,
        },
        {
          id: "rlm-obj-002",
          type: "file",
          description: "File 2",
          tokenEstimate: 200,
          createdAt: 1700000001000,
          byteOffset: 50,
          byteLength: 75,
        },
      ]);
      builder = new ManifestBuilder(store);
      const manifest = builder.build(500);
      expect(manifest).toContain("2 objects");
      expect(manifest).toContain("300 tokens");
    });

    it("should respect token budget and collapse excess entries", () => {
      const entries: StoreIndexEntry[] = [];
      for (let i = 0; i < 10; i++) {
        entries.push({
          id: `rlm-obj-${String(i).padStart(3, "0")}`,
          type: "conversation",
          description: `Message ${i}`,
          tokenEstimate: 100,
          createdAt: 1700000000000 + i * 1000,
          byteOffset: i * 100,
          byteLength: 100,
        });
      }
      store = new MockExternalStore(entries);
      builder = new ManifestBuilder(store);

      // With a small budget (200 tokens), most entries should be collapsed
      const manifest = builder.build(200);

      // Should have collapsed summary
      expect(manifest).toContain("+");
      expect(manifest).toContain("older");

      // Should not show all entries individually (older ones collapsed)
      expect(manifest).toContain("rlm-obj-009");
      expect(manifest).not.toContain("rlm-obj-000");
      expect(manifest).not.toContain("rlm-obj-001");
    });

    it("should show recent entries even with small budget", () => {
      const entries: StoreIndexEntry[] = [];
      for (let i = 0; i < 10; i++) {
        entries.push({
          id: `rlm-obj-${String(i).padStart(3, "0")}`,
          type: "conversation",
          description: `Message ${i}`,
          tokenEstimate: 100,
          createdAt: 1700000000000 + i * 1000,
          byteOffset: i * 100,
          byteLength: 100,
        });
      }
      store = new MockExternalStore(entries);
      builder = new ManifestBuilder(store);

      // Most recent entry (rlm-obj-009) should be shown
      const manifest = builder.build(200);
      expect(manifest).toContain("rlm-obj-009");
    });

    it("should include collapsed summary with token count", () => {
      const entries: StoreIndexEntry[] = [];
      for (let i = 0; i < 5; i++) {
        entries.push({
          id: `rlm-obj-${String(i).padStart(3, "0")}`,
          type: "conversation",
          description: `Message ${i}`,
          tokenEstimate: 100,
          createdAt: 1700000000000 + i * 1000,
          byteOffset: i * 100,
          byteLength: 100,
        });
      }
      store = new MockExternalStore(entries);
      builder = new ManifestBuilder(store);

      const manifest = builder.build(200);

      // Should have collapsed entry with token sum
      expect(manifest).toMatch(/\+\d+ older/);
      // Older entries' tokens should be in collapsed summary
      expect(manifest).toMatch(/\d+.*older.*\|.*\d+/);
    });

    it("should handle single entry", () => {
      store = new MockExternalStore([
        {
          id: "rlm-obj-single",
          type: "tool_output",
          description: "bash: npm test",
          tokenEstimate: 500,
          createdAt: 1700000000000,
          byteOffset: 0,
          byteLength: 200,
        },
      ]);
      builder = new ManifestBuilder(store);
      const manifest = builder.build(500);
      expect(manifest).toContain("rlm-obj-single");
      expect(manifest).toContain("1 objects");
      expect(manifest).not.toContain("+");
    });

    it("should format table rows correctly", () => {
      store = new MockExternalStore([
        {
          id: "rlm-obj-abc",
          type: "file",
          description: "test.ts",
          tokenEstimate: 250,
          createdAt: 1700000000000,
          byteOffset: 0,
          byteLength: 100,
        },
      ]);
      builder = new ManifestBuilder(store);
      const manifest = builder.build(500);

      // Should have markdown table structure
      expect(manifest).toContain("|");
      expect(manifest).toContain("Object ID");
      expect(manifest).toContain("Type");
      expect(manifest).toContain("Tokens");
      expect(manifest).toContain("Description");
      expect(manifest).toContain("---");
    });

    it("should handle high token budget (show all entries)", () => {
      const entries: StoreIndexEntry[] = [];
      for (let i = 0; i < 5; i++) {
        entries.push({
          id: `rlm-obj-${String(i).padStart(3, "0")}`,
          type: "conversation",
          description: `Message ${i}`,
          tokenEstimate: 100,
          createdAt: 1700000000000 + i * 1000,
          byteOffset: i * 100,
          byteLength: 100,
        });
      }
      store = new MockExternalStore(entries);
      builder = new ManifestBuilder(store);

      const manifest = builder.build(10000); // High budget
      // All entries should appear (no collapsed summary)
      for (let i = 0; i < 5; i++) {
        expect(manifest).toContain(`rlm-obj-${String(i).padStart(3, "0")}`);
      }
    });

    it("should group content types correctly", () => {
      store = new MockExternalStore([
        {
          id: "rlm-obj-file",
          type: "file",
          description: "src/index.ts",
          tokenEstimate: 500,
          createdAt: 1700000002000,
          byteOffset: 0,
          byteLength: 200,
        },
        {
          id: "rlm-obj-tool",
          type: "tool_output",
          description: "bash output",
          tokenEstimate: 300,
          createdAt: 1700000001000,
          byteOffset: 200,
          byteLength: 150,
        },
        {
          id: "rlm-obj-conv",
          type: "conversation",
          description: "User: Where is X?",
          tokenEstimate: 100,
          createdAt: 1700000000000,
          byteOffset: 350,
          byteLength: 50,
        },
      ]);
      builder = new ManifestBuilder(store);
      const manifest = builder.build(1000);

      expect(manifest).toContain("file");
      expect(manifest).toContain("tool_output");
      expect(manifest).toContain("conversation");
    });
  });

  describe("Edge cases", () => {
    it("should handle store with no entries", () => {
      expect(() => builder.build(500)).not.toThrow();
      const manifest = builder.build(500);
      expect(manifest).toBeTruthy();
    });

    it("should handle very small budget", () => {
      store = new MockExternalStore([
        {
          id: "rlm-obj-001",
          type: "file",
          description: "Large file",
          tokenEstimate: 10000,
          createdAt: 1700000000000,
          byteOffset: 0,
          byteLength: 5000,
        },
      ]);
      builder = new ManifestBuilder(store);
      expect(() => builder.build(50)).not.toThrow();
      const manifest = builder.build(50);
      // Should still include the most recent entry
      expect(manifest).toContain("rlm-obj-001");
    });

    it("should handle entries with no description", () => {
      store = new MockExternalStore([
        {
          id: "rlm-obj-nodesc",
          type: "conversation",
          description: "",
          tokenEstimate: 100,
          createdAt: 1700000000000,
          byteOffset: 0,
          byteLength: 50,
        },
      ]);
      builder = new ManifestBuilder(store);
      expect(() => builder.build(500)).not.toThrow();
      const manifest = builder.build(500);
      expect(manifest).toContain("rlm-obj-nodesc");
    });

    it("should use total token count from index", () => {
      store = new MockExternalStore([
        {
          id: "rlm-obj-001",
          type: "file",
          description: "File",
          tokenEstimate: 500,
          createdAt: 1700000000000,
          byteOffset: 0,
          byteLength: 200,
        },
        {
          id: "rlm-obj-002",
          type: "file",
          description: "File 2",
          tokenEstimate: 300,
          createdAt: 1700000001000,
          byteOffset: 200,
          byteLength: 150,
        },
      ]);
      builder = new ManifestBuilder(store);
      const manifest = builder.build(500);
      // Should show correct total
      expect(manifest).toContain("800 tokens");
    });
  });
});
