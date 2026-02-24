/**
 * Core type definitions for Pi-RLM.
 * These are defined here to avoid circular dependencies and provide a stable interface
 * across modules. Task-2 will implement ExternalStore, TrajectoryLogger, and WarmTracker.
 */

// ============================================================================
// Core Result Types
// ============================================================================

export interface ChildCallResult {
  answer: string;
  confidence: "high" | "medium" | "low";
  evidence: string[];
}

/**
 * A match result from rlm_search.
 */
export interface SearchMatch {
  objectId: string;
  offset: number;                 // Character offset of match in object content
  snippet: string;                // The matched text
  context: string;                // ±100 chars surrounding the match
  error?: string;                 // Present if search failed for this object
}

// ============================================================================
// Extension Context (placeholder for pi-ai types)
// ============================================================================

export interface Model {
  id: string;
  label: string;
  cost: {
    input: number; // $/Mtok (dollars per million tokens)
    output: number; // $/Mtok
  };
}

export interface ExtensionContext {
  cwd: string;
  hasUI: boolean;
  model?: Model;
  modelRegistry?: {
    find(provider: string, id: string): Model | undefined;
  };
  getContextUsage(): { tokens: number | null; contextWindow: number } | null;
}

// ============================================================================
// Store Types (from task-2: ExternalStore)
// ============================================================================

export type ContentType = "conversation" | "tool_output" | "file" | "artifact";

export interface StoreRecord {
  id: string;
  type: ContentType;
  description: string;
  createdAt: number;
  tokenEstimate: number;
  source: StoreObjectSource;
  content: string;
}

export type StoreObjectSource =
  | { kind: "externalized"; fingerprint: string }
  | { kind: "ingested"; path: string }
  | { kind: "child_result"; callId: string };

export interface StoreIndexEntry {
  id: string;
  type: ContentType;
  description: string;
  tokenEstimate: number;
  createdAt: number;
  byteOffset: number;
  byteLength: number;
}

export interface StoreIndex {
  version: 1;
  sessionId: string;
  objects: StoreIndexEntry[];
  totalTokens: number;
}

// ExternalStore interface — to be implemented by task-2
export interface IExternalStore {
  get(id: string): StoreRecord | null;
  getIndexEntry(id: string): StoreIndexEntry | null;
  add(obj: Omit<StoreRecord, "id" | "createdAt">): StoreRecord;
  getAllIds(): string[];
  getFullIndex(): StoreIndex;
  findByIngestPath(path: string): string | null;
  initialize(): Promise<void>;
  flush(): Promise<void>;
  clear?(): Promise<void>;
  mergeFrom(otherStoreDir: string): Promise<void>;
  rebuildExternalizedMap(): void;
  getExternalizedId(fingerprint: string): string | null;
  addExternalized(fingerprint: string, objectId: string): void;
}

// ============================================================================
// Trajectory Types (from task-2: TrajectoryLogger)
// ============================================================================

export interface CallTrajectoryRecord {
  kind: "call";
  callId: string;
  operationId: string;
  parentCallId: string | null;
  depth: number;
  model: string;
  query: string;
  targetIds: string[];
  result: ChildCallResult | null;
  tokensIn: number;
  tokensOut: number;
  wallClockMs: number;
  status: "success" | "error" | "cancelled" | "timeout";
  error?: string;
  timestamp: number;
}

export interface OperationTrajectoryRecord {
  kind: "operation";
  operation: "externalize" | "force_externalize" | "search" | "ingest" | "peek" | "stats" | "toggle_on" | "toggle_off";
  objectIds?: string[];
  details?: Record<string, unknown>;
  wallClockMs: number;
  timestamp: number;
}

export type TrajectoryRecord = CallTrajectoryRecord | OperationTrajectoryRecord;

// TrajectoryLogger interface — to be implemented by task-2
export interface ITrajectoryLogger {
  append(record: TrajectoryRecord): void;
  flush(): Promise<void>;
  getTrajectoryPath?(): string;
}

// ============================================================================
// WarmTracker Types (from task-2: WarmTracker)
// ============================================================================

export interface IWarmTracker {
  markWarm(objectIds: string[]): void;
  markToolCallWarm(toolCallId: string): void;
  isWarm(objectId: string): boolean;
  isToolCallWarm(toolCallId: string): boolean;
  tick(): void;
}

// ============================================================================
// TokenOracle Types (from task-4: TokenOracle)
// ============================================================================

export interface ITokenOracle {
  observe(charCount: number, actualTokens: number): void;
  estimate(charCount: number): number;
  estimateSafe(charCount: number, coverage?: number): number;
  isCold(): boolean;
  getStats(): { observationCount: number; meanRatio: number; coverage95Quantile: number };
}

// ============================================================================
// Configuration
// ============================================================================

export interface RlmConfig {
  enabled: boolean;
  maxDepth: number;
  maxConcurrency: number;
  tokenBudgetPercent: number;
  safetyValvePercent: number;
  manifestBudget: number;
  warmTurns: number;
  childTimeoutSec: number;
  operationTimeoutSec: number;
  maxChildCalls: number;
  childMaxTokens: number;
  childModel?: string;
  previousSessionId?: string;
  systemPromptOverride?: string;
  retentionDays: number;
  maxIngestFiles: number;
  maxIngestBytes: number;
}

// ============================================================================
// Phase enum (for widget and status tracking)
// ============================================================================

export type Phase = "externalizing" | "searching" | "querying" | "batching" | "synthesizing" | "ingesting";
