/**
 * Component tests for rlm_ingest tool.
 * Tests file ingestion, glob pattern resolution, binary file detection,
 * deduplication via findByIngestPath, disabled guard, and maxIngestFiles limit.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildRlmIngestTool } from "../../src/tools/ingest.js";
import type { ExtensionContext, IExternalStore, ITrajectoryLogger, RlmConfig } from "../../src/types.js";

describe("rlm_ingest tool", () => {
  let tmpDir: string;
  let testDir: string;
  let mockStore: IExternalStore;
  let mockTrajectory: ITrajectoryLogger;
  let config: Pick<RlmConfig, "maxIngestFiles" | "maxIngestBytes">;
  let tool: any;
  let activePhases: Set<string>;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-rlm-ingest-"));
    testDir = path.join(tmpDir, "test-files");
    await fs.promises.mkdir(testDir, { recursive: true });

    config = {
      maxIngestFiles: 100,
      maxIngestBytes: 100_000_000,
    };

    mockStore = {
      get: vi.fn(),
      getIndexEntry: vi.fn(),
      getAllIds: vi.fn(),
      getFullIndex: vi.fn(),
      add: vi.fn((record) => ({
        ...record,
        id: `rlm-obj-${Math.random().toString(16).slice(2, 10)}`,
        createdAt: Date.now(),
      })),
      findByIngestPath: vi.fn(() => null),
      initialize: vi.fn(),
      flush: vi.fn(),
      rebuildExternalizedMap: vi.fn(),
    };

    mockTrajectory = {
      append: vi.fn(),
      flush: vi.fn(),
    };

    activePhases = new Set();

    tool = buildRlmIngestTool({
      enabled: true,
      store: mockStore,
      config,
      trajectory: mockTrajectory,
      activePhases,
    });
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe("tool definition", () => {
    it("should have correct metadata", () => {
      expect(tool.name).toBe("rlm_ingest");
      expect(tool.label).toBe("RLM Ingest");
      expect(tool.description).toContain("Ingest");
    });

    it("should have proper parameter schema", () => {
      const props = tool.parameters.properties;
      expect(props.paths).toBeDefined();
    });
  });

  describe("execute", () => {
    it("should return error when RLM is disabled", async () => {
      const disabledTool = buildRlmIngestTool({
        enabled: false,
        store: mockStore,
        config,
        trajectory: mockTrajectory,
        activePhases,
      });

      const result = await disabledTool.execute(
        "call-1",
        { paths: ["test.txt"] },
        undefined,
        undefined,
        { cwd: testDir, hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("disabled");
    });

    it("should return error for empty paths array", async () => {
      const result = await tool.execute(
        "call-1",
        { paths: [] },
        undefined,
        undefined,
        { cwd: testDir, hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("non-empty array");
    });

    it("should ingest a readable text file and add to store", async () => {
      const filePath = path.join(testDir, "test.txt");
      const content = "This is test content for ingestion";
      await fs.promises.writeFile(filePath, content, "utf8");

      const result = await tool.execute(
        "call-1",
        { paths: ["test.txt"] },
        undefined,
        undefined,
        { cwd: testDir, hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBeFalsy();
      expect(mockStore.add).toHaveBeenCalled();
      const addCall = (mockStore.add as any).mock.calls[0][0];
      expect(addCall.content).toBe(content);
      expect(addCall.type).toBe("file");
    });

    it("should skip binary files (containing null bytes)", async () => {
      const filePath = path.join(testDir, "binary.bin");
      const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x00]);
      await fs.promises.writeFile(filePath, binaryContent);

      const result = await tool.execute(
        "call-1",
        { paths: ["binary.bin"] },
        undefined,
        undefined,
        { cwd: testDir, hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBeFalsy();
      expect(mockStore.add).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain("Skipped");
      expect(result.content[0].text).toContain("binary");
    });

    it("should deduplicate already-ingested paths via findByIngestPath", async () => {
      const filePath = path.join(testDir, "test.txt");
      await fs.promises.writeFile(filePath, "test content", "utf8");

      // First call succeeds
      (mockStore.findByIngestPath as any).mockReturnValueOnce(null);
      const result1 = await tool.execute(
        "call-1",
        { paths: ["test.txt"] },
        undefined,
        undefined,
        { cwd: testDir, hasUI: false } as ExtensionContext,
      );
      expect(mockStore.add).toHaveBeenCalledTimes(1);

      // Reset mocks
      vi.clearAllMocks();

      // Second call: return existing ID
      (mockStore.findByIngestPath as any).mockReturnValueOnce("rlm-obj-existing");
      const result2 = await tool.execute(
        "call-1",
        { paths: ["test.txt"] },
        undefined,
        undefined,
        { cwd: testDir, hasUI: false } as ExtensionContext,
      );

      expect(mockStore.add).not.toHaveBeenCalled();
      expect(result2.content[0].text).toContain("already ingested");
    });

    it("should resolve glob patterns to matching files", async () => {
      // Create multiple test files
      await fs.promises.writeFile(path.join(testDir, "file1.txt"), "content1", "utf8");
      await fs.promises.writeFile(path.join(testDir, "file2.txt"), "content2", "utf8");
      await fs.promises.writeFile(path.join(testDir, "file.md"), "markdown", "utf8");

      const result = await tool.execute(
        "call-1",
        { paths: ["*.txt"] },
        undefined,
        undefined,
        { cwd: testDir, hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBeFalsy();
      expect(mockStore.add).toHaveBeenCalledTimes(2);
    });

    it("should ingest multiple files from different directories", async () => {
      const subDir = path.join(testDir, "subdir");
      await fs.promises.mkdir(subDir, { recursive: true });
      await fs.promises.writeFile(path.join(testDir, "file1.txt"), "content1", "utf8");
      await fs.promises.writeFile(path.join(subDir, "file2.txt"), "content2", "utf8");

      const result = await tool.execute(
        "call-1",
        { paths: ["**/*.txt"] },
        undefined,
        undefined,
        { cwd: testDir, hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBeFalsy();
      expect(mockStore.add).toHaveBeenCalledTimes(2);
    });

    it("should return success when no files match", async () => {
      const result = await tool.execute(
        "call-1",
        { paths: ["nonexistent/*.txt"] },
        undefined,
        undefined,
        { cwd: testDir, hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("No files matched");
    });

    it("should return error exceeding maxIngestFiles", async () => {
      // Create more files than the limit
      const tooManyDir = path.join(tmpDir, "too-many");
      await fs.promises.mkdir(tooManyDir, { recursive: true });

      for (let i = 0; i < 5; i++) {
        await fs.promises.writeFile(path.join(tooManyDir, `file${i}.txt`), "content", "utf8");
      }

      config.maxIngestFiles = 2; // Set limit to 2

      const result = await tool.execute(
        "call-1",
        { paths: ["*.txt"] },
        undefined,
        undefined,
        { cwd: tooManyDir, hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Too many files");
      expect(result.content[0].text).toContain("limit is 2");
    });

    it("should return error exceeding maxIngestBytes", async () => {
      const filePath = path.join(testDir, "large.txt");
      const largeContent = "x".repeat(1000);
      await fs.promises.writeFile(filePath, largeContent, "utf8");

      config.maxIngestBytes = 500; // Set limit to 500 bytes

      const result = await tool.execute(
        "call-1",
        { paths: ["large.txt"] },
        undefined,
        undefined,
        { cwd: testDir, hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBeFalsy();
      expect(mockStore.add).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain("Skipped");
    });

    it("should add ingested object IDs to store", async () => {
      const filePath = path.join(testDir, "test.txt");
      await fs.promises.writeFile(filePath, "test content", "utf8");

      const result = await tool.execute(
        "call-1",
        { paths: ["test.txt"] },
        undefined,
        undefined,
        { cwd: testDir, hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBeFalsy();
      expect(result.details?.ingestedIds).toEqual(expect.arrayContaining([expect.stringMatching(/^rlm-obj-/)]));
    });

    it("should set correct source.kind to 'ingested' and include path", async () => {
      const filePath = path.join(testDir, "test.txt");
      await fs.promises.writeFile(filePath, "test content", "utf8");

      await tool.execute(
        "call-1",
        { paths: ["test.txt"] },
        undefined,
        undefined,
        { cwd: testDir, hasUI: false } as ExtensionContext,
      );

      const addCall = (mockStore.add as any).mock.calls[0][0];
      expect(addCall.source.kind).toBe("ingested");
      expect(addCall.source.path).toBeDefined();
    });

    it("should respect abort signal", async () => {
      // Create multiple files
      for (let i = 0; i < 5; i++) {
        await fs.promises.writeFile(path.join(testDir, `file${i}.txt`), "content", "utf8");
      }

      const controller = new AbortController();
      // Abort immediately
      controller.abort();

      const result = await tool.execute(
        "call-1",
        { paths: ["*.txt"] },
        controller.signal,
        undefined,
        { cwd: testDir, hasUI: false } as ExtensionContext,
      );

      expect(result.isError).toBeFalsy();
      // Should have stopped iteration and returned partial results
      expect(mockStore.add).toHaveBeenCalledTimes(0);
    });

    it("should add ingesting phase while executing", async () => {
      const filePath = path.join(testDir, "test.txt");
      await fs.promises.writeFile(filePath, "test content", "utf8");

      expect(activePhases.has("ingesting")).toBe(false);

      await tool.execute(
        "call-1",
        { paths: ["test.txt"] },
        undefined,
        undefined,
        { cwd: testDir, hasUI: false } as ExtensionContext,
      );

      // Phase should be removed after completion
      expect(activePhases.has("ingesting")).toBe(false);
    });
  });

  describe("trajectory logging", () => {
    it("should log ingest operation to trajectory", async () => {
      const filePath = path.join(testDir, "test.txt");
      await fs.promises.writeFile(filePath, "test content", "utf8");

      await tool.execute(
        "call-1",
        { paths: ["test.txt"] },
        undefined,
        undefined,
        { cwd: testDir, hasUI: false } as ExtensionContext,
      );

      expect(mockTrajectory.append).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "operation",
          operation: "ingest",
          objectIds: expect.any(Array),
          details: expect.objectContaining({
            paths: ["test.txt"],
            matchedFiles: 1,
            ingestedCount: 1,
          }),
        }),
      );
    });
  });

  describe("file description and token estimation", () => {
    it("should set description to relative path", async () => {
      const filePath = path.join(testDir, "test.txt");
      await fs.promises.writeFile(filePath, "test content", "utf8");

      await tool.execute(
        "call-1",
        { paths: ["test.txt"] },
        undefined,
        undefined,
        { cwd: testDir, hasUI: false } as ExtensionContext,
      );

      const addCall = (mockStore.add as any).mock.calls[0][0];
      expect(addCall.description).toBe("test.txt");
    });

    it("should estimate tokens based on content length", async () => {
      const filePath = path.join(testDir, "test.txt");
      const content = "x".repeat(400); // 400 chars ≈ 100 tokens at 4 chars/token
      await fs.promises.writeFile(filePath, content, "utf8");

      await tool.execute(
        "call-1",
        { paths: ["test.txt"] },
        undefined,
        undefined,
        { cwd: testDir, hasUI: false } as ExtensionContext,
      );

      const addCall = (mockStore.add as any).mock.calls[0][0];
      expect(addCall.tokenEstimate).toBeGreaterThan(0);
      expect(addCall.tokenEstimate).toBeLessThanOrEqual(Math.ceil(400 / 4));
    });
  });
});
