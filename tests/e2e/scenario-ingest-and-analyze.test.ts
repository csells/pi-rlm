import { describe, it, beforeAll, afterAll, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { PiHarness } from "../helpers/pi-harness";
import {
  expectToolUsed,
  expectAnswerContains,
} from "../helpers/assertions";

describe("Scenario: ingest and analyze", () => {
  let pi: PiHarness;
  let testDir: string;

  beforeAll(async () => {
    // Create a small test project to ingest
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rlm-e2e-"));
    await fs.promises.writeFile(
      path.join(testDir, "math.ts"),
      `export function add(a: number, b: number): number { return a + b; }\n` +
      `export function multiply(a: number, b: number): number { return a * b; }\n`
    );
    await fs.promises.writeFile(
      path.join(testDir, "string.ts"),
      `export function capitalize(s: string): string { return s[0].toUpperCase() + s.slice(1); }\n` +
      `export function reverse(s: string): string { return s.split("").reverse().join(""); }\n`
    );
    await fs.promises.writeFile(
      path.join(testDir, "index.ts"),
      `export { add, multiply } from "./math";\n` +
      `export { capitalize, reverse } from "./string";\n`
    );

    pi = await PiHarness.start("./src/index.ts", { cwd: testDir });
  }, 30_000);

  afterAll(async () => {
    await pi.stop();
    await fs.promises.rm(testDir, { recursive: true });
  });

  it(
    "ingests files and can query across them",
    async () => {
      // Step 1: Ingest the project
      const ingestEvents = await pi.prompt(
        `Use rlm_ingest to ingest all .ts files in ${testDir}`
      );
      expectToolUsed(ingestEvents, "rlm_ingest");

      // Step 2: Ask an analytical question that spans files
      pi.clearEvents();
      const queryEvents = await pi.prompt(
        "Using the RLM store, list all exported functions across all files " +
        "and categorize them by their parameter types"
      );

      // Model should use rlm_query or rlm_peek + rlm_search to answer
      const rlmCalls = queryEvents.filter(e =>
        e.type === "tool_execution_end" && e.toolName?.startsWith("rlm_")
      );
      expect(rlmCalls.length).toBeGreaterThan(0);

      // Answer should reference all functions
      const text = pi.lastAssistantText(queryEvents).toLowerCase();
      expect(text).toContain("add");
      expect(text).toContain("multiply");
      expect(text).toContain("capitalize");
      expect(text).toContain("reverse");
    },
    { timeout: 180_000, retry: 1 }
  );

  it(
    "batch analysis works over ingested objects",
    async () => {
      pi.clearEvents();
      const batchEvents = await pi.prompt(
        "Use rlm_batch to analyze each ingested file and generate a one-line " +
        "summary of what it exports"
      );
      expectToolUsed(batchEvents, "rlm_batch");

      // Batch should have processed multiple objects
      const batchResults = batchEvents.filter(e =>
        e.type === "tool_execution_end" && e.toolName === "rlm_batch"
      );
      expect(batchResults.length).toBeGreaterThan(0);
    },
    { timeout: 180_000, retry: 1 }
  );
});
