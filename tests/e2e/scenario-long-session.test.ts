import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { PiHarness } from "../helpers/pi-harness";
import {
  expectToolUsed,
  expectAnswerContains,
} from "../helpers/assertions";

describe("Scenario: long session with externalization and retrieval", () => {
  let pi: PiHarness;

  beforeAll(async () => {
    pi = await PiHarness.start("./src/index.ts");
  }, 30_000);

  afterAll(async () => {
    await pi.stop();
  });

  it(
    "reads a large file, externalizes it, then retrieves facts from it",
    async () => {
      // Turn 1: Read a large file — this generates a big tool output
      await pi.prompt("Read /etc/services and tell me how many lines it has");

      // Turns 2–6: Generate enough context to push past the externalization threshold
      for (let i = 0; i < 5; i++) {
        pi.clearEvents();
        await pi.prompt(
          `Read /etc/services from line ${i * 200 + 1} to ${(i + 1) * 200} and ` +
          `list any services on port 80-100 in that range`
        );
      }

      // Turn 7: Ask about the original content — model must retrieve from store
      pi.clearEvents();
      const events = await pi.prompt(
        "What port does the 'http' service use according to /etc/services?"
      );

      // Model MUST use an RLM tool to answer (content was externalized)
      const rlmCalls = events.filter(e =>
        e.type === "tool_execution_end" && e.toolName?.startsWith("rlm_")
      );
      expect(rlmCalls.length, "Model must use RLM tools to retrieve externalized content")
        .toBeGreaterThan(0);

      // Model MUST get the right answer
      expectAnswerContains(pi, "80", events);
    },
    { timeout: 300_000, retry: 1 }
  );

  it(
    "never triggers auto-compaction",
    async () => {
      // After all those turns, compaction should NOT have fired
      expect(pi.compactionCount()).toBe(0);
    },
    { timeout: 10_000 }
  );
});
