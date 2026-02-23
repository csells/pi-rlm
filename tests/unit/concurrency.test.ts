/**
 * Unit tests for ConcurrencyLimiter.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ConcurrencyLimiter } from "../../src/engine/concurrency.js";

describe("ConcurrencyLimiter", () => {
  let limiter: ConcurrencyLimiter;

  beforeEach(() => {
    limiter = new ConcurrencyLimiter(2);
  });

  describe("map", () => {
    it("should map over an array with results in original order", async () => {
      const input = [1, 2, 3];
      const results = await limiter.map(input, async (x) => x * 2);

      expect(results).toEqual([2, 4, 6]);
    });

    it("should respect concurrency limit", async () => {
      const concurrency = 2;
      const limiter2 = new ConcurrencyLimiter(concurrency);
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const input = Array.from({ length: 5 }, (_, i) => i);

      const results = await limiter2.map(input, async (x) => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);

        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 10));

        currentConcurrent--;
        return x * 2;
      });

      expect(results).toEqual([0, 2, 4, 6, 8]);
      expect(maxConcurrent).toBeLessThanOrEqual(concurrency);
    });

    it("should handle empty input", async () => {
      const results = await limiter.map([], async (x) => x);
      expect(results).toEqual([]);
    });

    it("should handle single item", async () => {
      const results = await limiter.map([1], async (x) => x * 2);
      expect(results).toEqual([2]);
    });

    it("should propagate errors", async () => {
      const input = [1, 2, 3];
      const error = new Error("Test error");

      await expect(
        limiter.map(input, async (x) => {
          if (x === 2) throw error;
          return x;
        }),
      ).rejects.toThrow("Test error");
    });

    it("should preserve input order even with async delays", async () => {
      const input = [3, 1, 2];
      const results = await limiter.map(input, async (x) => {
        // Reverse order delays to test that order is preserved
        const delay = 50 - x * 10;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return x * 10;
      });

      expect(results).toEqual([30, 10, 20]);
    });
  });
});
