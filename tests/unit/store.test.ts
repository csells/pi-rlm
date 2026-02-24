/**
 * Unit tests for ExternalStore.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ExternalStore } from "../../src/store/store.js";
import type { StoreRecord, ContentType } from "../../src/types.js";

describe("ExternalStore", () => {
  let tmpDir: string;
  let store: ExternalStore;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-rlm-store-"));
    store = new ExternalStore(tmpDir, "test-session");
  });

  afterEach(async () => {
    // Flush queue before cleanup to ensure all writes complete
    await store.flush();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe("initialize()", () => {
    it("should create directory if it does not exist", async () => {
      const newDir = path.join(tmpDir, "new-store");
      const newStore = new ExternalStore(newDir, "test-session-2");
      await newStore.initialize();

      const stat = await fs.promises.stat(newDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it("should load existing index and JSONL data", async () => {
      const storeDir = path.join(tmpDir, "existing-store");
      await fs.promises.mkdir(storeDir, { recursive: true });

      // Create a pre-existing JSONL file
      const record: StoreRecord = {
        id: "rlm-obj-test",
        type: "conversation",
        description: "test",
        createdAt: 123456,
        tokenEstimate: 100,
        source: { kind: "externalized", fingerprint: "fp-1" },
        content: "test content",
      };
      const recordLine = JSON.stringify(record) + "\n";
      await fs.promises.writeFile(path.join(storeDir, "store.jsonl"), recordLine, "utf-8");

      // Create index
      const index = {
        version: 1,
        sessionId: "test-session-existing",
        objects: [
          {
            id: "rlm-obj-test",
            type: "conversation" as const,
            description: "test",
            tokenEstimate: 100,
            createdAt: 123456,
            byteOffset: 0,
            byteLength: recordLine.length,
          },
        ],
        totalTokens: 100,
      };
      await fs.promises.writeFile(path.join(storeDir, "index.json"), JSON.stringify(index), "utf-8");

      const newStore = new ExternalStore(storeDir, "test-session-existing");
      await newStore.initialize();

      const loaded = newStore.get("rlm-obj-test");
      expect(loaded).not.toBeNull();
      expect(loaded?.type).toBe("conversation");
      expect(loaded?.description).toBe("test");
    });
  });

  describe("add()", () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it("should add a record and return it with generated id and createdAt", () => {
      const record = store.add({
        type: "conversation",
        description: "test conversation",
        tokenEstimate: 500,
        source: { kind: "externalized", fingerprint: "fp-1" },
        content: "hello world",
      });

      expect(record.id).toBeDefined();
      expect(record.id).toMatch(/^rlm-obj-[a-f0-9]+$/);
      expect(record.createdAt).toBeDefined();
      expect(typeof record.createdAt).toBe("number");
      expect(record.type).toBe("conversation");
      expect(record.description).toBe("test conversation");
      expect(record.tokenEstimate).toBe(500);
      expect(record.content).toBe("hello world");
    });

    it("should generate unique IDs for each record", () => {
      const record1 = store.add({
        type: "conversation",
        description: "first",
        tokenEstimate: 100,
        source: { kind: "externalized", fingerprint: "fp-1" },
        content: "content1",
      });

      const record2 = store.add({
        type: "conversation",
        description: "second",
        tokenEstimate: 200,
        source: { kind: "externalized", fingerprint: "fp-2" },
        content: "content2",
      });

      expect(record1.id).not.toBe(record2.id);
    });
  });

  describe("get()", () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it("should return a record by id", () => {
      const added = store.add({
        type: "conversation",
        description: "test",
        tokenEstimate: 100,
        source: { kind: "externalized", fingerprint: "fp-1" },
        content: "test content",
      });

      const retrieved = store.get(added.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(added.id);
      expect(retrieved?.description).toBe("test");
    });

    it("should return null for missing id", () => {
      const retrieved = store.get("nonexistent-id");
      expect(retrieved).toBeNull();
    });
  });

  describe("getAllIds()", () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it("should return all object IDs", () => {
      const r1 = store.add({
        type: "conversation",
        description: "first",
        tokenEstimate: 100,
        source: { kind: "externalized", fingerprint: "fp-1" },
        content: "content1",
      });

      const r2 = store.add({
        type: "conversation",
        description: "second",
        tokenEstimate: 200,
        source: { kind: "externalized", fingerprint: "fp-2" },
        content: "content2",
      });

      const ids = store.getAllIds();
      expect(ids).toContain(r1.id);
      expect(ids).toContain(r2.id);
      expect(ids.length).toBeGreaterThanOrEqual(2);
    });

    it("should return empty array when store is empty", () => {
      const ids = store.getAllIds();
      expect(ids).toEqual([]);
    });
  });

  describe("getFullIndex()", () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it("should return StoreIndex structure with all fields", () => {
      store.add({
        type: "conversation",
        description: "test",
        tokenEstimate: 500,
        source: { kind: "externalized", fingerprint: "fp-1" },
        content: "test content",
      });

      const index = store.getFullIndex();
      expect(index.version).toBe(1);
      expect(index.sessionId).toBe("test-session");
      expect(Array.isArray(index.objects)).toBe(true);
      expect(index.totalTokens).toBeGreaterThanOrEqual(500);
    });

    it("should return independent copy of index", () => {
      const index1 = store.getFullIndex();
      const index2 = store.getFullIndex();

      expect(index1).toEqual(index2);
      expect(index1).not.toBe(index2);
      expect(index1.objects).not.toBe(index2.objects);
    });
  });

  describe("findByIngestPath()", () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it("should find a record by ingest path", () => {
      const record = store.add({
        type: "file",
        description: "ingested file",
        tokenEstimate: 300,
        source: { kind: "ingested", path: "/path/to/file.ts" },
        content: "file content",
      });

      const foundId = store.findByIngestPath("/path/to/file.ts");
      expect(foundId).toBe(record.id);
    });

    it("should return null for non-existent path", () => {
      const foundId = store.findByIngestPath("/nonexistent/path.ts");
      expect(foundId).toBeNull();
    });

    it("should only match ingested records, not other kinds", () => {
      store.add({
        type: "conversation",
        description: "externalized",
        tokenEstimate: 100,
        source: { kind: "externalized", fingerprint: "fp-1" },
        content: "content",
      });

      const foundId = store.findByIngestPath("some/path");
      expect(foundId).toBeNull();
    });
  });

  describe("flush()", () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it("should write pending data to disk", async () => {
      store.add({
        type: "conversation",
        description: "test",
        tokenEstimate: 100,
        source: { kind: "externalized", fingerprint: "fp-1" },
        content: "test content",
      });

      await store.flush();

      const storePath = path.join(tmpDir, "store.jsonl");
      const data = await fs.promises.readFile(storePath, "utf-8");
      expect(data).toContain("test content");
    });

    it("should resolve when queue is empty", async () => {
      await store.flush();
      // Should not hang or error
      expect(true).toBe(true);
    });
  });

  describe("clear()", () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it("should remove files and reset state", async () => {
      store.add({
        type: "conversation",
        description: "test",
        tokenEstimate: 100,
        source: { kind: "externalized", fingerprint: "fp-1" },
        content: "test content",
      });

      await store.flush();
      await store.clear();

      // In-memory state should be reset
      expect(store.getAllIds()).toEqual([]);
      expect(store.getFullIndex().totalTokens).toBe(0);

      // Files should be removed or empty
      const storePath = path.join(tmpDir, "store.jsonl");
      const exists = await fs.promises
        .stat(storePath)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        const data = await fs.promises.readFile(storePath, "utf-8");
        expect(data.trim()).toBe("");
      }
    });
  });

  describe("rebuildExternalizedMap()", () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it("should populate externalized map from records with externalized source", () => {
      const record = store.add({
        type: "conversation",
        description: "test",
        tokenEstimate: 100,
        source: { kind: "externalized", fingerprint: "fp-test-123" },
        content: "content",
      });

      store.rebuildExternalizedMap();

      const found = store.getExternalizedId("fp-test-123");
      expect(found).toBe(record.id);
    });

    it("should clear previous map entries when rebuilding", () => {
      const record = store.add({
        type: "conversation",
        description: "test",
        tokenEstimate: 100,
        source: { kind: "externalized", fingerprint: "fp-1" },
        content: "content",
      });

      // Add an externalized entry manually
      store.addExternalized("fp-old", "old-id");

      // Rebuild should only have records from actual store
      store.rebuildExternalizedMap();

      expect(store.getExternalizedId("fp-1")).toBe(record.id);
      expect(store.getExternalizedId("fp-old")).toBeNull();
    });
  });

  describe("getExternalizedId()", () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it("should return object ID for fingerprint", () => {
      store.addExternalized("fp-key", "obj-123");
      const found = store.getExternalizedId("fp-key");
      expect(found).toBe("obj-123");
    });

    it("should return null for missing fingerprint", () => {
      const found = store.getExternalizedId("nonexistent");
      expect(found).toBeNull();
    });
  });

  describe("addExternalized()", () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it("should register an externalized message", () => {
      store.addExternalized("fp-new", "obj-456");
      const found = store.getExternalizedId("fp-new");
      expect(found).toBe("obj-456");
    });

    it("should overwrite existing fingerprint mapping", () => {
      store.addExternalized("fp-key", "obj-1");
      store.addExternalized("fp-key", "obj-2");
      const found = store.getExternalizedId("fp-key");
      expect(found).toBe("obj-2");
    });
  });

  describe("Crash recovery in initialize()", () => {
    it("should skip corrupt JSONL lines and load valid ones", async () => {
      const storeDir = path.join(tmpDir, "crash-recovery-store");
      await fs.promises.mkdir(storeDir, { recursive: true });

      // Create a JSONL file with a corrupt line in the middle
      const validRecord1: StoreRecord = {
        id: "rlm-obj-valid-1",
        type: "conversation",
        description: "first valid",
        createdAt: 123456,
        tokenEstimate: 100,
        source: { kind: "externalized", fingerprint: "fp-1" },
        content: "valid content 1",
      };

      const validRecord2: StoreRecord = {
        id: "rlm-obj-valid-2",
        type: "conversation",
        description: "second valid",
        createdAt: 123457,
        tokenEstimate: 200,
        source: { kind: "externalized", fingerprint: "fp-2" },
        content: "valid content 2",
      };

      const corruptLine = "this is not valid json\n";

      const jsonlContent =
        JSON.stringify(validRecord1) +
        "\n" +
        corruptLine +
        JSON.stringify(validRecord2) +
        "\n";

      await fs.promises.writeFile(path.join(storeDir, "store.jsonl"), jsonlContent, "utf-8");

      // Create index
      const index = {
        version: 1,
        sessionId: "crash-recovery-test",
        objects: [
          {
            id: "rlm-obj-valid-1",
            type: "conversation" as const,
            description: "first valid",
            tokenEstimate: 100,
            createdAt: 123456,
            byteOffset: 0,
            byteLength: 100,
          },
          {
            id: "rlm-obj-valid-2",
            type: "conversation" as const,
            description: "second valid",
            tokenEstimate: 200,
            createdAt: 123457,
            byteOffset: 150,
            byteLength: 100,
          },
        ],
        totalTokens: 300,
      };
      await fs.promises.writeFile(path.join(storeDir, "index.json"), JSON.stringify(index), "utf-8");

      const newStore = new ExternalStore(storeDir, "crash-recovery-test");
      
      // Capture console.warn calls
      const warnSpy = { called: false, message: "" };
      const originalWarn = console.warn;
      console.warn = (msg: any) => {
        if (String(msg).includes("Failed to parse JSONL line")) {
          warnSpy.called = true;
          warnSpy.message = String(msg);
        }
        originalWarn(msg);
      };

      try {
        await newStore.initialize();

        // Should have loaded both valid records and skipped the corrupt one
        expect(newStore.get("rlm-obj-valid-1")).not.toBeNull();
        expect(newStore.get("rlm-obj-valid-2")).not.toBeNull();
        
        // Should have warned about the corrupt line
        expect(warnSpy.called).toBe(true);
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  describe("byteOffset/byteLength tracking", () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it("should set byteOffset/byteLength to -1 before flush completes", () => {
      const record = store.add({
        type: "conversation",
        description: "test",
        tokenEstimate: 100,
        source: { kind: "externalized", fingerprint: "fp-1" },
        content: "test content",
      });

      // Before flush, the index entry should have -1 for both
      const indexEntry = store.getIndexEntry(record.id);
      expect(indexEntry).not.toBeNull();
      expect(indexEntry?.byteOffset).toBe(-1);
      expect(indexEntry?.byteLength).toBe(-1);
    });

    it("should set correct byteOffset/byteLength after add() + flush()", async () => {
      const record = store.add({
        type: "conversation",
        description: "test record",
        tokenEstimate: 250,
        source: { kind: "externalized", fingerprint: "fp-test" },
        content: "this is test content",
      });

      // Flush to ensure the write completes
      await store.flush();

      // After flush, the index entry should have valid byte values
      const indexEntry = store.getIndexEntry(record.id);
      expect(indexEntry).not.toBeNull();
      expect(indexEntry?.byteOffset).toBeGreaterThanOrEqual(0);
      expect(indexEntry?.byteLength).toBeGreaterThan(0);

      // The byte offset and length should reflect the actual file position
      const storePath = path.join(tmpDir, "store.jsonl");
      const fileData = await fs.promises.readFile(storePath, "utf-8");
      const recordLine = JSON.stringify(record) + "\n";
      expect(fileData.includes(recordLine)).toBe(true);
    });

    it("should track multiple records with correct offsets", async () => {
      const record1 = store.add({
        type: "conversation",
        description: "first",
        tokenEstimate: 100,
        source: { kind: "externalized", fingerprint: "fp-1" },
        content: "content one",
      });

      const record2 = store.add({
        type: "conversation",
        description: "second",
        tokenEstimate: 200,
        source: { kind: "externalized", fingerprint: "fp-2" },
        content: "content two with more text",
      });

      await store.flush();

      const entry1 = store.getIndexEntry(record1.id);
      const entry2 = store.getIndexEntry(record2.id);

      expect(entry1).not.toBeNull();
      expect(entry2).not.toBeNull();

      // Both should have valid offsets and lengths
      expect(entry1!.byteOffset).toBeGreaterThanOrEqual(0);
      expect(entry1!.byteLength).toBeGreaterThan(0);
      expect(entry2!.byteOffset).toBeGreaterThanOrEqual(0);
      expect(entry2!.byteLength).toBeGreaterThan(0);

      // Second record offset should be after the first
      expect(entry2!.byteOffset).toBeGreaterThanOrEqual(entry1!.byteOffset + entry1!.byteLength);
    });
  });
});
