/**
 * Store data types and utility functions.
 * Defines the schema for externalized content, indices, and search results.
 */

/**
 * Type of content stored in the external store.
 */
export type ContentType = "conversation" | "tool_output" | "file" | "artifact";

/**
 * Source information for how a store record was created.
 */
export type StoreObjectSource =
  | { kind: "externalized"; fingerprint: string }     // From context externalization
  | { kind: "ingested"; path: string }                // From rlm_ingest
  | { kind: "child_result"; callId: string };         // From recursive call

/**
 * A single record stored in the external JSONL store.
 * Each line in store.jsonl is one StoreRecord.
 */
export interface StoreRecord {
  id: string;                     // e.g., "rlm-obj-a1b2c3d4"
  type: ContentType;              // Content type
  description: string;            // Human/LLM-readable summary, ≤100 chars
  createdAt: number;              // Unix timestamp (ms)
  tokenEstimate: number;          // Estimated tokens (chars / 4)
  source: StoreObjectSource;      // How this object entered the store
  content: string;                // The raw content
}

/**
 * Entry in the store index (more compact than StoreRecord).
 * Used for in-memory indexing and persisted in index.json.
 */
export interface StoreIndexEntry {
  id: string;
  type: ContentType;
  description: string;
  tokenEstimate: number;
  createdAt: number;
  byteOffset: number;             // Offset in store.jsonl for fast seek
  byteLength: number;             // Length in store.jsonl
}

/**
 * The store index — persisted as index.json.
 * Tracks all objects in the store for quick lookup.
 */
export interface StoreIndex {
  version: 1;
  sessionId: string;
  objects: StoreIndexEntry[];
  totalTokens: number;            // Sum of all tokenEstimate values
}

/**
 * Structured result from a recursive child call.
 * Used for validation and fallback wrapping.
 */
export interface ChildCallResult {
  answer: string;
  confidence: "high" | "medium" | "low";
  evidence: string[];             // Relevant quotes or references
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

/**
 * Parse a raw response string from a child call into a structured ChildCallResult.
 * Falls back to wrapping the raw text if parsing fails.
 */
export function parseChildResult(raw: string): ChildCallResult {
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.answer === "string" &&
      ["high", "medium", "low"].includes(parsed.confidence) &&
      Array.isArray(parsed.evidence)
    ) {
      return parsed;
    }
  } catch {
    // Fall through to fallback
  }
  // Fallback: wrap raw text
  return { answer: raw, confidence: "low", evidence: [] };
}

/**
 * Format search results into a human-readable string.
 * Used by rlm_search tool to present results to the LLM.
 */
export function formatSearchResults(matches: SearchMatch[]): string {
  if (matches.length === 0) {
    return "No matches found.";
  }

  const lines: string[] = [`Found ${matches.length} match(es):\n`];
  for (const m of matches) {
    if (m.error) {
      lines.push(`**${m.objectId}**: ${m.error}`);
    } else {
      lines.push(`**${m.objectId}** [offset ${m.offset}]:`);
      lines.push(`  ...${m.context}...`);
    }
  }
  return lines.join("\n");
}
