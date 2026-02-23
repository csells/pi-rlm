/**
 * RlmConfig and default configuration for Pi-RLM.
 * This module defines the configuration schema and default values.
 */

export interface RlmConfig {
  // Core feature toggles
  enabled: boolean;               // Default: true

  // Externalization parameters
  maxDepth: number;               // Default: 2
  maxConcurrency: number;         // Default: 4
  tokenBudgetPercent: number;     // Default: 60
  safetyValvePercent: number;     // Default: 90
  manifestBudget: number;         // Default: 2000 (tokens)
  warmTurns: number;              // Default: 3

  // Recursive call parameters
  childTimeoutSec: number;        // Default: 120
  operationTimeoutSec: number;    // Default: 600
  maxChildCalls: number;          // Default: 50
  childMaxTokens: number;         // Default: 4096
  childModel?: string;            // Optional: "provider/model-id" for children

  // Store management
  retentionDays: number;          // Default: 30
  maxIngestFiles: number;         // Default: 1000 — per-invocation file cap
  maxIngestBytes: number;         // Default: 100_000_000 (100MB) — per-invocation size cap
}

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
