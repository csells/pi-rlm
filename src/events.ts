/**
 * Event handling utilities for Pi-RLM.
 *
 * Per §12.1 (Error Handling Strategy), provides:
 * 1. safeHandler() wrapper for event handlers
 * 2. pi.events emission helpers for RLM-specific events
 *
 * The safeHandler wrapper catches all exceptions, logs them, and returns
 * undefined (allowing Pi to use defaults), preventing extension crashes.
 */

/**
 * Wrap an event handler to catch exceptions and prevent crashing Pi.
 *
 * Per §12.1, event handlers wrapped with safeHandler return undefined on
 * error, allowing Pi to use its default behavior. Exceptions are logged
 * to the console for debugging.
 *
 * @param name - Name of the handler (for logging)
 * @param fn - The async handler function
 * @returns A wrapped handler that catches exceptions
 *
 * @example
 * ```typescript
 * pi.on("context", safeHandler("context", onContext));
 * ```
 */
export function safeHandler<T>(
  name: string,
  fn: (...args: any[]) => Promise<T> | T,
): (...args: any[]) => Promise<T | undefined> {
  return async (...args: any[]): Promise<T | undefined> => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error(`[pi-rlm] ${name} error:`, err);
      return undefined;
    }
  };
}

/**
 * Wrap a tool executor to catch exceptions and return error results.
 *
 * Per §12.1, tools wrapped with safeToolExecute return an error ToolResult
 * on exception, allowing the LLM to see the error. Exceptions are logged.
 *
 * @param name - Name of the tool (for logging)
 * @param fn - The async tool function
 * @returns A wrapped tool that catches exceptions and returns error results
 *
 * @example
 * ```typescript
 * registerTool({
 *   execute: safeToolExecute("rlm_query", queryTool),
 * });
 * ```
 */
export function safeToolExecute(
  name: string,
  fn: (
    toolCallId: string,
    params: any,
    signal: any,
    onUpdate: any,
    ctx: any,
  ) => Promise<{ content: any[]; isError?: boolean }>,
): (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<{ content: any[]; isError?: boolean }> {
  return async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
    try {
      return await fn(toolCallId, params, signal, onUpdate, ctx);
    } catch (err) {
      console.error(`[pi-rlm] ${name} error:`, err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text",
            text: `RLM error (${name}): ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  };
}

/**
 * Helper to emit RLM-specific events via pi.events.
 *
 * Per NFR-4.3, RLM emits events for inter-extension communication:
 * - rlm:externalize — When content is externalized to the store
 * - rlm:query:start — When a rlm_query child call starts
 * - rlm:query:end — When a rlm_query child call completes
 *
 * @example
 * ```typescript
 * emitEvent("rlm:externalize", { objectIds: ["rlm-obj-123"], count: 3 });
 * emitEvent("rlm:query:start", { operationId: "op-456", depth: 1 });
 * emitEvent("rlm:query:end", { operationId: "op-456", success: true });
 * ```
 */
export interface RlmEventMap {
  "rlm:externalize": {
    objectIds: string[];
    count: number;
    tokensSaved: number;
  };
  "rlm:query:start": {
    operationId: string;
    callId: string;
    depth: number;
    model: string;
  };
  "rlm:query:end": {
    operationId: string;
    callId: string;
    success: boolean;
    tokensIn?: number;
    tokensOut?: number;
    error?: string;
  };
  "rlm:batch:start": {
    operationId: string;
    objectCount: number;
  };
  "rlm:batch:end": {
    operationId: string;
    success: boolean;
    completedCount: number;
    error?: string;
  };
  "rlm:search": {
    query: string;
    matchCount: number;
    objectsSearched: number;
  };
  "rlm:ingest": {
    fileCount: number;
    totalBytes: number;
    objectIds: string[];
  };
  "rlm:toggle": {
    enabled: boolean;
  };
}

/**
 * Emit an RLM event for inter-extension communication.
 *
 * This is a no-op stub — callers should pass pi.events explicitly if
 * available, or we can wire it up at the call site.
 *
 * @param eventName - The event name (e.g., "rlm:externalize")
 * @param data - The event data
 */
export function emitEvent<K extends keyof RlmEventMap>(
  pi: any,
  eventName: K,
  data: RlmEventMap[K],
): void {
  if (!pi || !pi.events || !pi.events.emit) {
    return; // pi.events not available
  }

  try {
    pi.events.emit(eventName, data);
  } catch (err) {
    console.error(`[pi-rlm] Failed to emit event "${eventName}":`, err);
  }
}
