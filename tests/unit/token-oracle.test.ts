/**
 * Unit tests for TokenOracle (self-calibrating token estimation).
 */

import { describe, it, expect } from "vitest";
import { TokenOracle } from "../../src/context/token-oracle.js";

describe("TokenOracle", () => {
  it("should start in cold state", () => {
    const oracle = new TokenOracle();
    expect(oracle.isCold()).toBe(true);
  });

  it("should use chars/4 fallback when cold", () => {
    const oracle = new TokenOracle();
    const estimate = oracle.estimate(400);
    expect(estimate).toBe(100); // 400 / 4 = 100
  });

  it("should use chars/3 fallback for safe when cold", () => {
    const oracle = new TokenOracle();
    const estimate = oracle.estimateSafe(300);
    expect(estimate).toBe(100); // 300 / 3 = 100
  });

  it("should transition to warm state after 10 observations", () => {
    const oracle = new TokenOracle();
    for (let i = 0; i < 10; i++) {
      oracle.observe(400, 100); // ratio: 4
    }
    expect(oracle.isCold()).toBe(false);
  });

  it("should compute mean ratio from observations", () => {
    const oracle = new TokenOracle();
    oracle.observe(400, 100); // ratio: 4
    oracle.observe(300, 100); // ratio: 3
    oracle.observe(500, 100); // ratio: 5

    // Need 10 observations to warm up
    for (let i = 0; i < 7; i++) {
      oracle.observe(400, 100);
    }

    // Mean ratio = (4+3+5+4*7) / 10 = (12 + 28) / 10 = 4
    const estimate = oracle.estimate(400);
    expect(estimate).toBe(100); // 400 / 4 = 100
  });

  it("should use oracle estimate when warmed", () => {
    const oracle = new TokenOracle();
    // Add observations with consistent ratio of 2 (e.g., 200 chars = 100 tokens)
    for (let i = 0; i < 10; i++) {
      oracle.observe(200, 100); // ratio: 2
    }

    // Now oracle should estimate: 300 / 2 = 150
    const estimate = oracle.estimate(300);
    expect(estimate).toBe(150);
  });

  it("should maintain sliding window capped at 200", () => {
    const oracle = new TokenOracle();
    // Add more than 200 observations
    for (let i = 0; i < 250; i++) {
      oracle.observe(400 + i, 100 + Math.floor(i / 4));
    }

    const stats = oracle.getStats();
    expect(stats.observationCount).toBe(200); // Should be capped
  });

  it("should provide stats", () => {
    const oracle = new TokenOracle();
    for (let i = 0; i < 10; i++) {
      oracle.observe(400, 100);
    }

    const stats = oracle.getStats();
    expect(stats.observationCount).toBe(10);
    expect(stats.meanRatio).toBe(4);
    expect(typeof stats.coverage95Quantile).toBe("number");
  });

  it("should ignore invalid observations", () => {
    const oracle = new TokenOracle();
    oracle.observe(0, 100); // Invalid: zero chars
    oracle.observe(-100, 50); // Invalid: negative
    oracle.observe(100, -50); // Invalid: negative tokens

    expect(oracle.isCold()).toBe(true); // Should still be cold
  });

  it("estimateSafe should include conformal quantile margin", () => {
    const oracle = new TokenOracle();
    // Add diverse observations
    for (let i = 0; i < 10; i++) {
      oracle.observe(400, 80 + i); // Varied token counts
    }

    const normalEst = oracle.estimate(400);
    const safeEst = oracle.estimateSafe(400);

    expect(safeEst).toBeGreaterThanOrEqual(normalEst); // Safe should be >= normal
  });

  it("should handle custom coverage levels", () => {
    const oracle = new TokenOracle();
    for (let i = 0; i < 10; i++) {
      oracle.observe(400, 100);
    }

    const safe90 = oracle.estimateSafe(400, 0.90);
    const safe95 = oracle.estimateSafe(400, 0.95);
    const safe99 = oracle.estimateSafe(400, 0.99);

    // Higher coverage should give more conservative (higher) estimates
    expect(safe99).toBeGreaterThanOrEqual(safe95);
    expect(safe95).toBeGreaterThanOrEqual(safe90);
  });
});
