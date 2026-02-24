/**
 * Integration test: Verify TokenOracle integration with token counting functions.
 * 
 * This test simulates how TokenOracle would be used in the context handler.
 */

import { describe, it, expect } from "vitest";
import { TokenOracle } from "../../src/context/token-oracle.js";

describe("TokenOracle Integration", () => {
  it("should integrate with token counting mock", () => {
    const oracle = new TokenOracle();

    // Warm up the oracle with observations
    // Simulate: actual text has 1000 chars per 250 tokens (ratio ~4)
    for (let i = 0; i < 10; i++) {
      oracle.observe(1000, 250);
    }

    expect(oracle.isCold()).toBe(false);

    // Mock message counting with oracle
    const messageChars = 2000;
    const estimatedTokens = oracle.estimate(messageChars);

    // Should estimate: 2000 / 4 = 500 tokens
    expect(estimatedTokens).toBe(500);

    // Safe estimate should be >= normal estimate
    const safeEstimate = oracle.estimateSafe(messageChars);
    expect(safeEstimate).toBeGreaterThanOrEqual(estimatedTokens);
  });

  it("should track real-world token evolution", () => {
    const oracle = new TokenOracle();

    // Day 1: Early training with consistent data (ratio of exactly 4)
    oracle.observe(400, 100); // ratio 4
    oracle.observe(800, 200); // ratio 4
    oracle.observe(1200, 300); // ratio 4
    oracle.observe(1600, 400); // ratio 4
    oracle.observe(2000, 500); // ratio 4
    oracle.observe(2400, 600); // ratio 4
    oracle.observe(2800, 700); // ratio 4
    oracle.observe(3200, 800); // ratio 4
    oracle.observe(3600, 900); // ratio 4
    oracle.observe(4000, 1000); // ratio 4

    // Should be warmed up
    expect(oracle.isCold()).toBe(false);

    // Check stats
    const stats = oracle.getStats();
    expect(stats.observationCount).toBe(10);
    expect(Math.abs(stats.meanRatio - 4) < 0.01).toBe(true); // Should be very close to 4

    // Fresh estimate
    const estimate = oracle.estimate(4000);
    expect(estimate).toBe(1000); // 4000 / 4 = 1000

    // Safe estimate should account for variance
    const safeEstimate = oracle.estimateSafe(4000);
    expect(safeEstimate).toBeGreaterThanOrEqual(1000);

    // Day 2: New observations come in - oracle adapts
    for (let i = 0; i < 5; i++) {
      oracle.observe(2000, 500); // ratio 4, consistent
    }

    // Still has about 15 observations (window not full), mean ratio should be stable
    expect(oracle.getStats().observationCount).toBe(15);
    expect(Math.abs(oracle.getStats().meanRatio - 4) < 0.01).toBe(true);
  });

  it("should handle coverage levels appropriately", () => {
    const oracle = new TokenOracle();

    // Create observations with some variance
    const observations = [
      [1000, 245],
      [1000, 248],
      [1000, 250],
      [1000, 252],
      [1000, 255],
      [1000, 250],
      [1000, 250],
      [1000, 250],
      [1000, 250],
      [1000, 250],
    ];

    for (const [chars, tokens] of observations) {
      oracle.observe(chars, tokens);
    }

    expect(oracle.isCold()).toBe(false);

    // Get estimates at different coverage levels
    const safeEstimate90 = oracle.estimateSafe(1000, 0.90);
    const safeEstimate95 = oracle.estimateSafe(1000, 0.95);
    const safeEstimate99 = oracle.estimateSafe(1000, 0.99);

    // Higher coverage should be more conservative (higher estimate)
    expect(safeEstimate99 >= safeEstimate95).toBe(true);
    expect(safeEstimate95 >= safeEstimate90).toBe(true);

    // All should be >= base estimate
    const baseEstimate = oracle.estimate(1000);
    expect(safeEstimate90 >= baseEstimate).toBe(true);
  });

  it("should reset coverage window and preserve statistics", () => {
    const oracle = new TokenOracle();

    // Build up observations
    for (let i = 0; i < 200; i++) {
      oracle.observe(1000 + i, 250 + Math.floor(i / 4));
    }

    expect(oracle.getStats().observationCount).toBe(200);

    // Add one more - should push out the oldest
    oracle.observe(2000, 500);
    expect(oracle.getStats().observationCount).toBe(200); // Still 200, max reached

    // Oracle should still be warm and provide reasonable estimates
    expect(oracle.isCold()).toBe(false);
    const estimate = oracle.estimate(4000);
    expect(estimate > 0).toBe(true);
  });
});
