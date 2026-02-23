import { describe, it, beforeAll, afterAll } from "vitest";
import { PiHarness } from "../helpers/pi-harness";
import { expectToolUsed } from "../helpers/assertions";

describe("Scenario: cancel mid-operation", () => {
  let pi: PiHarness;

  beforeAll(async () => {
    pi = await PiHarness.start("./src/index.ts");
  }, 30_000);

  afterAll(async () => {
    await pi.stop();
  });

  it(
    "/rlm cancel aborts operations but leaves RLM enabled",
    async () => {
      // Start a long operation
      pi.send({
        type: "prompt",
        message:
          "Use rlm_ingest to ingest /etc/services then use rlm_batch to " +
          "analyze every object in the store",
      });

      // Wait for first tool to start
      await pi.waitFor("tool_execution_start", 30_000);

      // Cancel
      pi.steer("/rlm cancel");
      await pi.waitFor("agent_end", 60_000);

      // Verify: RLM is still on — we can still use tools
      pi.clearEvents();
      const events = await pi.prompt("Use rlm_search to search for 'http'");
      expectToolUsed(events, "rlm_search");
    },
    { timeout: 180_000, retry: 1 }
  );
});
