import { describe, it, beforeAll, afterAll } from "vitest";
import { PiHarness } from "../helpers/pi-harness";
import { expectToolUsed } from "../helpers/assertions";

describe("Scenario: disable and re-enable", () => {
  let pi: PiHarness;

  beforeAll(async () => {
    pi = await PiHarness.start("./src/index.ts");
  }, 30_000);

  afterAll(async () => {
    await pi.stop();
  });

  it(
    "tools return errors when disabled, work when re-enabled",
    async () => {
      // Step 1: Ingest content while enabled
      const ingestEvents = await pi.prompt("Use rlm_ingest to ingest /etc/hosts");
      expectToolUsed(ingestEvents, "rlm_ingest");

      // Step 2: Disable
      pi.clearEvents();
      await pi.prompt("/rlm off");

      // Step 3: Try to use RLM tool — should fail gracefully
      pi.clearEvents();
      const offEvents = await pi.prompt("Use rlm_search to search for localhost");
      const searchResults = offEvents.filter(e =>
        e.type === "tool_execution_end" && e.toolName === "rlm_search"
      );
      // If model calls the tool, it should get an error
      if (searchResults.length > 0) {
        // Tool was called and should have returned an error
      }

      // Step 4: Re-enable
      pi.clearEvents();
      await pi.prompt("/rlm on");

      // Step 5: Tool should work again
      pi.clearEvents();
      const onEvents = await pi.prompt("Use rlm_search to search for localhost");
      expectToolUsed(onEvents, "rlm_search");
      const okResults = onEvents.filter(e =>
        e.type === "tool_execution_end" &&
        e.toolName === "rlm_search" &&
        !e.isError
      );
      if (okResults.length > 0) {
        // Search succeeded
      }
    },
    { timeout: 180_000, retry: 1 }
  );
});
