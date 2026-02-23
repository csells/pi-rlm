/**
 * Unit tests for regex timeout worker behavior in rlm_search.
 */

import { describe, it, expect } from "vitest";
import { searchWithWorkerTimeout } from "../../src/tools/search.js";

describe("searchWithWorkerTimeout", () => {
  it("returns matches for a normal regex", async () => {
    const content = "alpha beta gamma beta";
    const regex = /beta/g;

    const matches = await searchWithWorkerTimeout(content, regex, "obj-1", 1000);

    expect(matches.length).toBe(2);
    expect(matches[0]?.objectId).toBe("obj-1");
    expect(matches[0]?.snippet).toBe("beta");
  });

  it("returns timeout error for catastrophic regex", async () => {
    const content = "a".repeat(20_000) + "!";
    const regex = /(a+)+$/g;

    const matches = await searchWithWorkerTimeout(content, regex, "obj-timeout", 10);

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.objectId).toBe("obj-timeout");
    expect(matches[0]?.error ?? "").toContain("timed out");
  });
});
