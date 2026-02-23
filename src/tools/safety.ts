/**
 * Safety wrappers for RLM tools.
 * Ensures tools never crash Pi — errors are returned as structured results.
 * Per §12 Error Handling Strategy of the design spec.
 */

import { ExtensionContext } from "../types.js";

/**
 * Tool execute signature.
 */
export type ToolExecuteFn = (
  toolCallId: string,
  params: any,
  signal: AbortSignal | undefined,
  onUpdate: any,
  ctx: ExtensionContext,
) => Promise<ToolResult>;

/**
 * Tool result returned to Pi.
 */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details?: Record<string, unknown>;
}

/**
 * Wrap a tool's execute function with error handling.
 * Ensures the tool never throws — errors are returned as structured results.
 *
 * Per §12.1 of the design spec:
 * "For tools: return error result on error (LLM sees the error)"
 */
export function safeToolExecute(name: string, fn: ToolExecuteFn): ToolExecuteFn {
  return async (toolCallId, params, signal, onUpdate, ctx) => {
    try {
      return await fn(toolCallId, params, signal, onUpdate, ctx);
    } catch (err) {
      console.error(`[pi-rlm] ${name} error:`, err);
      return {
        content: [
          {
            type: "text" as const,
            text: `RLM error in ${name}: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  };
}

/**
 * Wrap an event handler with error handling.
 * For event handlers, return undefined on error (Pi uses defaults).
 *
 * Per §12.1 of the design spec:
 * "For event handlers: return undefined on error (Pi uses defaults)"
 */
export function safeHandler<T>(name: string, fn: (...args: any[]) => Promise<T>) {
  return async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error(`[pi-rlm] ${name} error:`, err);
      return undefined;
    }
  };
}

/**
 * Create a tool executor that can be registered with Pi.
 * Combines safeToolExecute with parameter validation.
 */
export function createToolExecutor<P extends Record<string, unknown>>(
  name: string,
  validateParams: (params: any) => P,
  execute: (params: P, toolCallId: string, signal?: AbortSignal, ctx?: ExtensionContext) => Promise<ToolResult>,
): ToolExecuteFn {
  return safeToolExecute(name, async (toolCallId, params, signal, onUpdate, ctx) => {
    const validParams = validateParams(params);
    return await execute(validParams, toolCallId, signal, ctx);
  });
}
