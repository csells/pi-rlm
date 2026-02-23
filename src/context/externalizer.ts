/**
 * Context Externalizer: Fingerprinting, message analysis, and context handlers.
 *
 * Per §3 and §5 of the design spec, this module provides:
 * - Message fingerprinting and helper analysis utilities
 * - Atomic tool-call/tool-result grouping
 * - Externalization + force-externalization algorithms
 * - Stub replacement for already externalized messages
 * - context and session_before_compact handlers
 */

import { emitEvent } from "../events.js";
import type {
  ExtensionContext,
  IExternalStore,
  ITrajectoryLogger,
  IWarmTracker,
  RlmConfig,
} from "../types.js";
import { countMessageTokens, countMessageTokensSafe } from "./tokens.js";
import type { ManifestBuilder } from "./manifest.js";

// ============================================================================
// Types (matching Pi's message schema)
// ============================================================================

export interface AgentMessage {
  role: "user" | "assistant" | "toolResult" | "system";
  content:
    | string
    | Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        arguments?: Record<string, unknown>;
      }>;
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

interface StubEntry {
  id: string;
  type: string;
  tokenEstimate: number;
  description: string;
}

/**
 * State required by context/compaction handlers.
 * This is implemented by index.ts RlmState.
 */
export interface ExternalizerState {
  enabled: boolean;
  config: RlmConfig;
  store: IExternalStore;
  manifest: ManifestBuilder;
  warmTracker: IWarmTracker;
  activePhases: Set<string>;
  turnCount: number;
  storeHealthy: boolean;
  allowCompaction: boolean;
  forceExternalizeOnNextTurn: boolean;
  trajectory?: ITrajectoryLogger;
  updateWidget?: (ctx: ExtensionContext) => void;
}

// ============================================================================
// Fingerprinting
// ============================================================================

/**
 * Compute a stable fingerprint for an AgentMessage.
 *
 * Per §3.1, the fingerprint is:
 * - For ToolResultMessage: "toolResult:<toolCallId>"
 * - For other messages: "<role>:<timestamp>"
 * - Fallback: "<role>:fallback:<hash>"
 */
export function messageFingerprint(msg: AgentMessage): string {
  if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
    return `toolResult:${msg.toolCallId}`;
  }

  if (typeof msg.timestamp === "number") {
    return `${msg.role}:${msg.timestamp}`;
  }

  console.warn("[pi-rlm] Message without timestamp — fingerprint fallback");
  const contentSnippet =
    typeof msg.content === "string"
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
 * Simple 32-bit hash for fallback fingerprinting.
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
 * Detect whether content is already an RLM stub.
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
 * Infer store content type for a message.
 */
export function inferContentType(
  msg: AgentMessage,
): "conversation" | "tool_output" | "file" | "artifact" {
  if (msg.role === "toolResult") {
    if (msg.toolName === "rlm_ingest") {
      return "file";
    }
    return "tool_output";
  }
  return "conversation";
}

/**
 * Generate concise manifest description for a message.
 */
export function generateDescription(msg: AgentMessage): string {
  const maxLen = 80;

  let text = "";
  if (typeof msg.content === "string") {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(" ");
  }

  const snippet = text.slice(0, maxLen).replace(/\n/g, " ");

  if (msg.role === "toolResult") {
    return `${msg.toolName || "tool"}: ${snippet}`;
  }
  if (msg.role === "assistant") {
    return `Assistant: ${snippet}`;
  }
  if (msg.role === "user") {
    return `User: ${snippet}`;
  }
  if (msg.role === "system") {
    return `System: ${snippet}`;
  }

  return `${msg.role}: ${snippet}`;
}

/**
 * Extract raw text content from a message.
 */
export function extractContent(msg: AgentMessage): string {
  if (typeof msg.content === "string") {
    return msg.content;
  }

  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .filter((t): t is string => typeof t === "string")
      .join("\n");
  }

  return "";
}

// ============================================================================
// Atomic Grouping
// ============================================================================

/**
 * Detect assistant messages that contain tool calls.
 */
export function hasToolCalls(msg: AgentMessage): boolean {
  return Array.isArray(msg.content) && msg.content.some((b) => b.type === "tool_use");
}

/**
 * Build atomic groups so assistant tool_call + tool_result are externalized together.
 */
export function buildAtomicGroups(messages: AgentMessage[]): AtomicGroup[] {
  const groups: AtomicGroup[] = [];
  const claimed = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    if (claimed.has(i)) continue;

    const msg = messages[i];

    if (msg.role === "assistant" && hasToolCalls(msg)) {
      const toolCallIds = new Set<string>();
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use" && block.id) {
            toolCallIds.add(block.id);
          }
        }
      }

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
        estimatedTokens: group.reduce((sum, m) => sum + estimateMessageTokens(m), 0),
      });
      continue;
    }

    if (msg.role === "toolResult") {
      // Orphaned result — skip defensively.
      continue;
    }

    groups.push({
      messages: [msg],
      fingerprints: [messageFingerprint(msg)],
      estimatedTokens: estimateMessageTokens(msg),
    });
  }

  return groups;
}

function estimateMessageTokens(msg: AgentMessage): number {
  return Math.ceil(extractContent(msg).length / 4);
}

// ============================================================================
// Externalization Tracking
// ============================================================================

/**
 * fingerprint -> objectId map for content externalized in this/previous turns.
 */
export const externalizedMessages = new Map<string, string>();

/**
 * Rebuild externalizedMessages from persisted records.
 */
export function rebuildExternalizedMap(
  storeRecords: Array<{ id: string; source: { kind: string; fingerprint?: string } }>,
): void {
  externalizedMessages.clear();
  for (const record of storeRecords) {
    if (record.source.kind === "externalized" && record.source.fingerprint) {
      externalizedMessages.set(record.source.fingerprint, record.id);
    }
  }
}

/**
 * Rebuild externalizedMessages directly from the store interface.
 */
export function rebuildExternalizedMessagesFromStore(store: IExternalStore): void {
  const records: Array<{ id: string; source: { kind: string; fingerprint?: string } }> = [];

  for (const id of store.getAllIds()) {
    const rec = store.get(id);
    if (!rec) continue;

    if (rec.source.kind === "externalized") {
      records.push({
        id: rec.id,
        source: { kind: "externalized", fingerprint: rec.source.fingerprint },
      });
    } else {
      records.push({ id: rec.id, source: { kind: rec.source.kind } });
    }
  }

  rebuildExternalizedMap(records);
}

// ============================================================================
// Stub Replacement
// ============================================================================

function buildStubText(entry: StubEntry): string {
  return [
    `[RLM externalized: ${entry.id} | ${entry.type} | ${entry.tokenEstimate.toLocaleString()} tokens | ${entry.description}]`,
    `Use rlm_peek("${entry.id}") to view, or rlm_search to find specific content.`,
  ].join("\n");
}

/**
 * Replace a message's content with an RLM stub.
 *
 * For assistant messages that originally contain tool_use blocks, preserve the
 * tool_use blocks to keep tool_call/tool_result contracts valid.
 */
export function replaceContentWithStub(msg: AgentMessage, entry: StubEntry): void {
  const stubText = buildStubText(entry);

  if (
    msg.role === "assistant" &&
    Array.isArray(msg.content) &&
    msg.content.some((b) => b.type === "tool_use")
  ) {
    const toolBlocks = msg.content.filter((b) => b.type === "tool_use");
    msg.content = [{ type: "text", text: stubText }, ...toolBlocks];
    return;
  }

  msg.content = [{ type: "text", text: stubText }];
}

/**
 * Replace all messages that have known externalized fingerprints with stubs.
 */
export function replaceExternalizedWithStubs(messages: AgentMessage[], store: IExternalStore): void {
  for (const msg of messages) {
    const fp = messageFingerprint(msg);
    const objectId = externalizedMessages.get(fp);
    if (!objectId) continue;

    const entry = store.getIndexEntry(objectId);
    if (!entry) continue;

    replaceContentWithStub(msg, {
      id: entry.id,
      type: entry.type,
      tokenEstimate: entry.tokenEstimate,
      description: entry.description,
    });
  }
}

// ============================================================================
// Externalization Algorithms
// ============================================================================

/**
 * Normal externalization pass (§5.2.1).
 */
export function externalize(
  messages: AgentMessage[],
  state: ExternalizerState,
  threshold: number,
  pi?: any,
): { objectIds: string[]; tokensSaved: number } {
  const start = Date.now();
  const groups = buildAtomicGroups(messages);

  const lastUserIndex = findLastIndex(messages, (m) => m.role === "user");
  const lastAssistantIndex = findLastIndex(messages, (m) => m.role === "assistant");
  const lastUser = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined;
  const lastAssistant =
    lastAssistantIndex >= 0 ? messages[lastAssistantIndex] : undefined;

  const candidates: Array<{ group: AtomicGroup; hasToolResult: boolean }> = [];

  for (const group of groups) {
    if (lastUser && group.messages.includes(lastUser)) continue;
    if (lastAssistant && group.messages.includes(lastAssistant)) continue;

    const hasWarmToolResult = group.messages.some(
      (m) =>
        m.role === "toolResult" &&
        typeof m.toolCallId === "string" &&
        state.warmTracker.isToolCallWarm(m.toolCallId),
    );
    if (hasWarmToolResult) continue;

    const hasWarmSourceObject = group.fingerprints.some((fp) => {
      const objectId = externalizedMessages.get(fp);
      return objectId ? state.warmTracker.isWarm(objectId) : false;
    });
    if (hasWarmSourceObject) continue;

    if (group.messages.some((m) => isStubContent(m))) continue;

    candidates.push({
      group,
      hasToolResult: group.messages.some((m) => m.role === "toolResult"),
    });
  }

  // Prioritize tool outputs first, then largest groups.
  candidates.sort((a, b) => {
    if (a.hasToolResult !== b.hasToolResult) {
      return a.hasToolResult ? -1 : 1;
    }
    return b.group.estimatedTokens - a.group.estimatedTokens;
  });

  const objectIds: string[] = [];
  let tokensSaved = 0;

  for (const candidate of candidates) {
    if (countMessageTokens(messages) <= threshold) break;

    for (let i = 0; i < candidate.group.messages.length; i++) {
      const message = candidate.group.messages[i];
      const fingerprint = candidate.group.fingerprints[i];

      if (externalizedMessages.has(fingerprint)) continue;
      if (isStubContent(message)) continue;

      const content = extractContent(message);
      if (!content) continue;

      const tokenEstimate = Math.ceil(content.length / 4);
      const obj = state.store.add({
        type: inferContentType(message),
        description: generateDescription(message),
        tokenEstimate,
        content,
        source: { kind: "externalized", fingerprint },
      });

      externalizedMessages.set(fingerprint, obj.id);
      replaceContentWithStub(message, obj);

      objectIds.push(obj.id);
      tokensSaved += tokenEstimate;
    }
  }

  if (objectIds.length > 0) {
    emitEvent(pi, "rlm:externalize", {
      objectIds,
      count: objectIds.length,
      tokensSaved,
    });

    state.trajectory?.append({
      kind: "operation",
      operation: "externalize",
      objectIds,
      details: { threshold, tokensSaved },
      wallClockMs: Date.now() - start,
      timestamp: Date.now(),
    });
  }

  return { objectIds, tokensSaved };
}

/**
 * Safety-valve externalization pass (§5.3).
 */
export function forceExternalize(
  messages: AgentMessage[],
  state: ExternalizerState,
  pi?: any,
): { objectIds: string[]; tokensSaved: number } {
  const start = Date.now();
  const groups = buildAtomicGroups(messages);

  const lastUserIndex = findLastIndex(messages, (m) => m.role === "user");
  const lastAssistantIndex = findLastIndex(messages, (m) => m.role === "assistant");
  const lastUser = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined;
  const lastAssistant =
    lastAssistantIndex >= 0 ? messages[lastAssistantIndex] : undefined;

  const objectIds: string[] = [];
  let tokensSaved = 0;

  for (const group of groups) {
    if (lastUser && group.messages.includes(lastUser)) continue;
    if (lastAssistant && group.messages.includes(lastAssistant)) continue;
    if (group.messages.some((m) => m.role === "system")) continue;

    for (let i = 0; i < group.messages.length; i++) {
      const message = group.messages[i];
      const fingerprint = group.fingerprints[i];

      if (message.role === "system") continue;
      if (externalizedMessages.has(fingerprint)) continue;
      if (isStubContent(message)) continue;

      const content = extractContent(message);
      if (!content) continue;

      const tokenEstimate = Math.ceil(content.length / 4);
      const obj = state.store.add({
        type: inferContentType(message),
        description: generateDescription(message),
        tokenEstimate,
        content,
        source: { kind: "externalized", fingerprint },
      });

      externalizedMessages.set(fingerprint, obj.id);
      replaceContentWithStub(message, obj);

      objectIds.push(obj.id);
      tokensSaved += tokenEstimate;
    }
  }

  if (objectIds.length > 0) {
    emitEvent(pi, "rlm:externalize", {
      objectIds,
      count: objectIds.length,
      tokensSaved,
    });

    state.trajectory?.append({
      kind: "operation",
      operation: "force_externalize",
      objectIds,
      details: { tokensSaved },
      wallClockMs: Date.now() - start,
      timestamp: Date.now(),
    });
  }

  return { objectIds, tokensSaved };
}

function injectManifest(messages: AgentMessage[], state: ExternalizerState): void {
  const index = state.store.getFullIndex();
  if (index.objects.length === 0) return;

  const firstUserIndex = messages.findIndex((m) => m.role === "user");
  if (firstUserIndex < 0) return;

  const manifest = state.manifest.build(state.config.manifestBudget);
  const prefix = `${manifest}\n\n---\n\n`;

  const msg = messages[firstUserIndex];
  if (Array.isArray(msg.content)) {
    msg.content.unshift({ type: "text", text: prefix });
    return;
  }

  if (typeof msg.content === "string") {
    msg.content = prefix + msg.content;
    return;
  }

  msg.content = [{ type: "text", text: prefix }];
}

// ============================================================================
// Event Handlers
// ============================================================================

/**
 * context handler (§4.4).
 */
export async function onContext(
  event: { messages?: AgentMessage[] },
  ctx: ExtensionContext,
  state: ExternalizerState,
  pi?: any,
): Promise<{ messages: AgentMessage[] } | undefined> {
  if (!state.enabled) return;
  if (!state.storeHealthy) return;

  const messages = Array.isArray(event.messages) ? event.messages : [];

  state.turnCount += 1;
  state.warmTracker.tick();

  // Phase 0: Always stub already-externalized messages.
  replaceExternalizedWithStubs(messages, state.store);

  const usage = ctx.getContextUsage?.();

  if (usage && usage.tokens !== null) {
    const threshold = usage.contextWindow * (state.config.tokenBudgetPercent / 100);
    const safetyThreshold = usage.contextWindow * (state.config.safetyValvePercent / 100);

    // Phase 1: Normal pass
    const postStubTokens = countMessageTokens(messages);
    if (state.forceExternalizeOnNextTurn || postStubTokens > threshold) {
      state.activePhases.add("externalizing");
      state.updateWidget?.(ctx);
      try {
        externalize(messages, state, threshold, pi);
        state.forceExternalizeOnNextTurn = false;
      } finally {
        state.activePhases.delete("externalizing");
        state.updateWidget?.(ctx);
      }
    }

    // Phase 2: Manifest injection
    injectManifest(messages, state);

    // Phase 3: Safety valve
    const postManifestTokens = countMessageTokensSafe(messages);
    if (postManifestTokens > safetyThreshold) {
      forceExternalize(messages, state, pi);

      const finalTokens = countMessageTokensSafe(messages);
      if (finalTokens > safetyThreshold) {
        state.allowCompaction = true;
      }
    }
  } else {
    // tokens unknown: still inject manifest/stubs but skip new externalization
    injectManifest(messages, state);
  }

  return { messages };
}

/**
 * session_before_compact handler (§4.5).
 */
export async function onBeforeCompact(
  _event: unknown,
  _ctx: ExtensionContext,
  state: Pick<ExternalizerState, "enabled" | "storeHealthy" | "allowCompaction">,
): Promise<{ cancel: true } | undefined> {
  if (!state.enabled) return;
  if (!state.storeHealthy) return;

  if (state.allowCompaction) {
    state.allowCompaction = false;
    return;
  }

  return { cancel: true };
}

// ============================================================================
// Utilities
// ============================================================================

function findLastIndex<T>(arr: T[], pred: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return i;
  }
  return -1;
}
