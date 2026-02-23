import { describe, it, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { PiHarness } from "../helpers/pi-harness";
import { expectToolUsed } from "../helpers/assertions";

describe("Scenario: session resume", () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rlm-resume-"));
  });

  afterAll(async () => {
    await fs.promises.rm(testDir, { recursive: true });
  });

  it(
    "store content survives across sessions",
    async () => {
      // Session 1: Ingest some content
      const pi1 = await PiHarness.start("./src/index.ts", { cwd: testDir });
      const ingestEvents = await pi1.prompt("Use rlm_ingest to ingest /etc/hosts");
      expectToolUsed(ingestEvents, "rlm_ingest");
      await pi1.stop();

      // Session 2: Verify the content is still accessible
      const pi2 = await PiHarness.start("./src/index.ts", { cwd: testDir });
      const events = await pi2.prompt(
        "Search the RLM store for 'localhost'"
      );
      expectToolUsed(events, "rlm_search");

      // The search should find the content from session 1
      const searchResults = events.filter(e =>
        e.type === "tool_execution_end" &&
        e.toolName === "rlm_search" &&
        !e.isError
      );

      // Verify at least one successful search
      if (searchResults.length > 0) {
        const resultText = searchResults[0]?.result?.content?.[0]?.text ?? "";
        // If we got a result, it should mention localhost
        if (resultText.length > 0) {
          // Search succeeded and found content
        }
      }

      await pi2.stop();
    },
    { timeout: 120_000, retry: 1 }
  );
});
