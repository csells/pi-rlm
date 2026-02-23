/**
 * Context Externalizer: Fingerprinting, message analysis, and atomic grouping.
 *
 * Per §3.1 and §5.2.0 of the design spec, this module provides:
 * 1. messageFingerprint() — stable identity for messages via role+timestamp or toolCallId
 * 2. simpleHash() — fast string hashing for fallback fingerprinting
 * 3. isStubContent() — detect if message is already a stub
 * 4. inferContentType() — classify message content
 * 5. generateDescription() — create concise message descriptions
 * 6. extractContent() — extract raw content from messages
 * 7. buildAtomicGroups() — group assistant+toolResult messages for atomic externalization
 * 8. hasToolCalls() — check if assistant message contains tool calls
 * 9. externalizedMessages — Map<fingerprint, objectId> for tracking externalized content
 */

// ============================================================================
// Types (matching Pi's message schema)
// ============================================================================

export interface AgentMessage {
  role: "user" | "assistant" | "toolResult" | "system";
  content: string | Array<{ type: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface AtomicGroup {
  messages: AgentMessage[];
  fingerprints: string[];
  estimatedTokens: number;
}

// ============================================================================
// Fingerprinting
// ============================================================================

/**
 * Compute a stable fingerprint for an AgentMessage.
 *
 * Per §3.1, the fingerprint is:
 * - For ToolResultMessage: "toolResult:<toolCallId>" (unique per tool invocation)
 * - For other messages: "<role>:<timestamp>" (millisecond precision, near-unique)
 * - Fallback (should not occur): "<role>:fallback:<hash>" with console.warn
 *
 * The fingerprint is stable across turns and used to track message identity
 * for externalization mapping.
 */
export function messageFingerprint(msg: AgentMessage): string {
  // ToolResultMessage: toolCallId is unique per tool invocation
  if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
    return `toolResult:${msg.toolCallId}`;
  }

  // Primary fingerprint: role + timestamp
  // Pi timestamps are millisecond-precision (Date.now()) and near-unique.
  if (typeof msg.timestamp === "number") {
    return `${msg.role}:${msg.timestamp}`;
  }

  // Fallback: should not occur with current Pi types.
  // If hit during validation, switch to WeakMap<AgentMessage, number> sequence counter.
  console.warn("[pi-rlm] Message without timestamp — fingerprint fallback");
  const contentSnippet = typeof msg.content === "string"
    ? msg.content.slice(0, 200)
    : Array.isArray(msg.content)
      ? msg.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("")
          .slice(0, 200)
      : "";
  return `${msg.role}:fallback:${simpleHash(contentSnippet)}`;
}

/**
 * Simple 32-bit hash function for fallback fingerprinting.
 * Fast, deterministic, and sufficient for generating unique fallback IDs.
 */
export function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

// ============================================================================
// Content Analysis
// ============================================================================

/**
 * Detect if message content is already a stub (to prevent re-externalization).
 *
 * Stubs have the format: "[RLM externalized: <objectId> | <type> | <tokens> | <description>]"
 */
export function isStubContent(msg: AgentMessage): boolean {
  const text =
    typeof msg.content === "string"
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
        : "";
  return text.startsWith("[RLM externalized:");
}

/**
 * Infer the content type of a message for store classification.
 *
 * Per §5.5, classification strategy:
 * - ToolResultMessage → "tool_output" (unless from rlm_ingest, then "file")
 * - AssistantMessage → "conversation"
 * - UserMessage → "conversation"
 * - SystemMessage → "conversation"
 */
export function inferContentType(msg: AgentMessage): "conversation" | "tool_output" | "file" | "artifact" {
  if (msg.role === "toolResult") {
    // Tool outputs are categorized as tool_output by default.
    // rlm_ingest results represent file content ingestion and are treated as file records.
    if (msg.toolName === "rlm_ingest") {
      return "file";
    }
    return "tool_output";
  }
  // User, assistant, and system messages are conversations.
  return "conversation";
}

/**
 * Generate a concise human-readable description for a message.
 *
 * Per §5.5, strategy:
 * - ToolResultMessage: "<toolName>: <first 80 chars of output>"
 * - AssistantMessage: "Assistant: <first 80 chars of text content>"
 * - UserMessage: "User: <first 80 chars of text>"
 * - SystemMessage: "System: <first 80 chars>"
 * - Fallback: "<role>: <snippet>"
 *
 * Max length: ~100 chars (for manifest display).
 */
export function generateDescription(msg: AgentMessage): string {
  const maxLen = 80;

  // Extract text content
  let text = "";
  if (typeof msg.content === "string") {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    const textBlocks = msg.content.filter((b) => b.type === "text");
    text = textBlocks.map((b) => b.text).join(" ");
  }

  const snippet = text.slice(0, maxLen).replace(/\n/g, " ");

  if (msg.role === "toolResult") {
    const toolName = msg.toolName || "tool";
    return `${toolName}: ${snippet}`;
  } else if (msg.role === "assistant") {
    return `Assistant: ${snippet}`;
  } else if (msg.role === "user") {
    return `User: ${snippet}`;
  } else if (msg.role === "system") {
    return `System: ${snippet}`;
  }

  return `${msg.role}: ${snippet}`;
}

/**
 * Extract raw text content from a message.
 *
 * Handles both string content (direct) and array of blocks (filter text blocks).
 * Used for storing content in the external store.
 */
export function extractContent(msg: AgentMessage): string {
  if (typeof msg.content === "string") {
    return msg.content;
  }

  if (Array.isArray(msg.content)) {
    // Filter to text blocks and concatenate
    const textParts = msg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .filter((t): t is string => t !== undefined);
    return textParts.join("\n");
  }

  return "";
}

// ============================================================================
// Atomic Grouping
// ============================================================================

/**
 * Check if an assistant message contains tool calls.
 *
 * Per §5.2.0, an assistant message with tool calls is grouped with its
 * corresponding ToolResultMessages for atomic externalization.
 */
export function hasToolCalls(msg: AgentMessage): boolean {
  return (
    Array.isArray(msg.content) &&
    msg.content.some((b) => b.type === "tool_use")
  );
}

/**
 * Pre-compute atomic groups from a message array.
 *
 * Per §5.2.0, atomic groups are:
 * 1. AssistantMessage with ToolCalls + all corresponding ToolResultMessages
 * 2. Orphaned ToolResultMessages are skipped defensively
 * 3. Plain User/Assistant/System messages (individually)
 *
 * This ensures that tool invocations and results are externalized together,
 * preserving the toolCall/toolResult contract.
 */
export function buildAtomicGroups(messages: AgentMessage[]): AtomicGroup[] {
  const groups: AtomicGroup[] = [];
  const claimed = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    if (claimed.has(i)) continue;
    const msg = messages[i];

    if (msg.role === "assistant" && hasToolCalls(msg)) {
      // Collect all toolCallIds from this assistant message
      const toolCallIds = new Set<string>();
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use" && block.id) {
            toolCallIds.add(block.id);
          }
        }
      }

      // Find all corresponding ToolResultMessages
      const group: AgentMessage[] = [msg];
      claimed.add(i);

      for (let j = i + 1; j < messages.length; j++) {
        if (claimed.has(j)) continue;
        const candidate = messages[j];
        if (
          candidate.role === "toolResult" &&
          candidate.toolCallId &&
          toolCallIds.has(candidate.toolCallId)
        ) {
          group.push(candidate);
          claimed.add(j);
        }
      }

      groups.push({
        messages: group,
        fingerprints: group.map((m) => messageFingerprint(m)),
        estimatedTokens: group.reduce(
          (sum, m) => sum + estimateMessageTokens(m),
          0
        ),
      });
    } else if (msg.role === "toolResult") {
      // Orphaned toolResult (its assistant was already claimed) — skip.
      // It will be handled as part of its assistant's group.
      continue;
    } else {
      // Standalone message (user, plain assistant, system)
      groups.push({
        messages: [msg],
        fingerprints: [messageFingerprint(msg)],
        estimatedTokens: estimateMessageTokens(msg),
      });
    }
  }

  return groups;
}

/**
 * Estimate token count for a message (chars / 4).
 * Used for token budgeting during externalization.
 */
function estimateMessageTokens(msg: AgentMessage): number {
  const content = extractContent(msg);
  return Math.ceil(content.length / 4);
}

// ============================================================================
// Externalization Tracking
// ============================================================================

/**
 * In-memory map of externalized messages.
 *
 * Maps fingerprint → storeObjectId for messages that have been externalized.
 * Used to replace previously-externalized content with stubs on subsequent turns.
 * Rebuilt from store on session start via store.rebuildExternalizedMap().
 *
 * Per §5.4, lookups use messageFingerprint() for stable identity across turns.
 */
export const externalizedMessages = new Map<string, string>();

/**
 * Rebuild the externalized messages map from the store.
 *
 * Called on session start (§4.2, step 4). Iterates all store records with
 * source.kind === "externalized" and populates externalizedMessages from
 * source.fingerprint → record.id.
 *
 * @param storeRecords - All records from the store
 */
export function rebuildExternalizedMap(
  storeRecords: Array<{ id: string; source: { kind: string; fingerprint?: string } }>
): void {
  externalizedMessages.clear();
  for (const record of storeRecords) {
    if (
      record.source.kind === "externalized" &&
      record.source.fingerprint
    ) {
      externalizedMessages.set(record.source.fingerprint, record.id);
    }
  }
}
