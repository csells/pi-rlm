import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRlmIngestTool, resolveGlobs } from "../../src/tools/ingest.js";

describe("rlm_ingest tool", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-rlm-ingest-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("resolveGlobs resolves recursively and deduplicates by path", async () => {
    await fs.promises.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.promises.writeFile(path.join(tmpDir, "src", "a.ts"), "export const a = 1;", "utf8");
    await fs.promises.writeFile(path.join(tmpDir, "src", "b.ts"), "export const b = 2;", "utf8");
    await fs.promises.writeFile(path.join(tmpDir, "src", "c.js"), "module.exports = 3;", "utf8");

    const matched = await resolveGlobs(["src/**/*.ts", "src/a.ts"], { cwd: tmpDir });

    expect(matched.length).toBe(2);
    expect(matched).toContain(path.join(tmpDir, "src", "a.ts"));
    expect(matched).toContain(path.join(tmpDir, "src", "b.ts"));
  });

  it("asks for confirmation when more than 10 files match", async () => {
    await fs.promises.mkdir(path.join(tmpDir, "many"), { recursive: true });
    for (let i = 0; i < 11; i++) {
      await fs.promises.writeFile(path.join(tmpDir, "many", `f-${i}.txt`), "hello", "utf8");
    }

    const confirm = vi.fn(async () => false);

    const tool = buildRlmIngestTool({
      enabled: true,
      store: { findByIngestPath: vi.fn(), add: vi.fn() } as any,
      config: { maxIngestFiles: 1000, maxIngestBytes: 1_000_000 },
      trajectory: { append: vi.fn() } as any,
      activePhases: new Set<string>(),
    });

    const result = await tool.execute(
      "call-1",
      { paths: ["many/**/*.txt"] },
      undefined,
      undefined,
      {
        cwd: tmpDir,
        hasUI: true,
        ui: { confirm },
      } as any,
    );

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Cancelled by user");
  });

  it("enforces maxIngestFiles", async () => {
    await fs.promises.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.promises.writeFile(path.join(tmpDir, "src", "a.ts"), "a", "utf8");
    await fs.promises.writeFile(path.join(tmpDir, "src", "b.ts"), "b", "utf8");
    await fs.promises.writeFile(path.join(tmpDir, "src", "c.ts"), "c", "utf8");

    const tool = buildRlmIngestTool({
      enabled: true,
      store: { findByIngestPath: vi.fn(), add: vi.fn() } as any,
      config: { maxIngestFiles: 2, maxIngestBytes: 1_000_000 },
      trajectory: { append: vi.fn() } as any,
      activePhases: new Set<string>(),
    });

    const result = await tool.execute(
      "call-2",
      { paths: ["src/**/*.ts"] },
      undefined,
      undefined,
      {
        cwd: tmpDir,
        hasUI: false,
      } as any,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Too many files");
  });

  it("ingests files, deduplicates existing paths, and respects maxIngestBytes", async () => {
    await fs.promises.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.promises.writeFile(path.join(tmpDir, "src", "a.ts"), "const a = 1;", "utf8");
    await fs.promises.writeFile(path.join(tmpDir, "src", "b.ts"), "const b = 2;", "utf8");

    const add = vi
      .fn()
      .mockReturnValueOnce({ id: "obj-a" })
      .mockReturnValueOnce({ id: "obj-b" });
    const findByIngestPath = vi
      .fn()
      .mockImplementation((p: string) => (p.endsWith("a.ts") ? "existing-a" : null));

    const append = vi.fn();

    const tool = buildRlmIngestTool({
      enabled: true,
      store: { findByIngestPath, add } as any,
      config: { maxIngestFiles: 1000, maxIngestBytes: 20 }, // only one file fits
      trajectory: { append } as any,
      activePhases: new Set<string>(),
    });

    const result = await tool.execute(
      "call-3",
      { paths: ["src/**/*.ts"] },
      undefined,
      undefined,
      {
        cwd: tmpDir,
        hasUI: false,
      } as any,
    );

    expect(result.isError).toBeUndefined();
    expect(findByIngestPath).toHaveBeenCalled();
    expect(add).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain("Ingested 1 file(s)");
    expect(result.content[0].text).toContain("Skipped");
    expect(append).toHaveBeenCalledTimes(1);
  });
});
