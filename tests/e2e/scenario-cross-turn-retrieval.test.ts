import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { PiHarness } from "../helpers/pi-harness";
import {
  expectToolUsed,
  expectAnswerContains,
} from "../helpers/assertions";

describe("Scenario: cross-turn retrieval", () => {
  let pi: PiHarness;

  beforeAll(async () => {
    pi = await PiHarness.start("./src/index.ts");
  }, 30_000);

  afterAll(async () => {
    await pi.stop();
  });

  it(
    "retrieves content discussed 10+ turns ago",
    async () => {
      // Turn 1: Discuss a specific topic
      await pi.prompt("Read /etc/hosts and explain every entry");

      // Turns 2–10: Build up lots of unrelated context to force externalization
      for (let i = 0; i < 9; i++) {
        await pi.prompt(
          `Read /etc/services from line ${i * 100 + 1} to ${(i + 1) * 100} ` +
          `and count TCP vs UDP entries`
        );
      }

      // Turn 11: Ask about the /etc/hosts content from turn 1
      pi.clearEvents();
      const events = await pi.prompt(
        "Remember when you read /etc/hosts at the start? " +
        "What was the IP address for localhost?"
      );

      // CRITICAL: Model must search external store — not say "I don't have it"
      expectToolUsed(events, "rlm_search");
      expectAnswerContains(pi, "127.0.0.1", events);
    },
    { timeout: 600_000, retry: 1 }
  );

  it(
    "manifest lists the hosts file object",
    async () => {
      pi.clearEvents();
      const events = await pi.prompt(
        "What objects are in your RLM external store? List them."
      );

      // Model should reference the manifest and mention the hosts file
      const text = pi.lastAssistantText(events).toLowerCase();
      expect(text).toContain("hosts");
      expect(text).toContain("rlm-obj-");
    },
    { timeout: 60_000, retry: 1 }
  );
});
