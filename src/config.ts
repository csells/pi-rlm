/**
 * RlmConfig and default configuration for Pi-RLM.
 * This module defines the default values and merge utility.
 * RlmConfig interface is defined in types.ts (the canonical source).
 */

import type { RlmConfig } from "./types.js";

export const DEFAULT_CONFIG: RlmConfig = {
  enabled: true,
  maxDepth: 2,
  maxConcurrency: 4,
  tokenBudgetPercent: 60,
  safetyValvePercent: 90,
  manifestBudget: 2000,
  warmTurns: 3,
  childTimeoutSec: 120,
  operationTimeoutSec: 600,
  maxChildCalls: 50,
  childMaxTokens: 4096,
  retentionDays: 30,
  maxIngestFiles: 1000,
  maxIngestBytes: 100_000_000,
};

/**
 * Merge a partial config with defaults.
 * Properties in partial override defaults; absent properties use defaults.
 */
export function mergeConfig(partial: Partial<RlmConfig>): RlmConfig {
  return {
    ...DEFAULT_CONFIG,
    ...partial,
  };
}
