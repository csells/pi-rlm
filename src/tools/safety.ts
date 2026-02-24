/**
 * Safety wrappers for RLM tools.
 * Ensures tools never crash Pi — errors are returned as structured results.
 * Per §12 Error Handling Strategy of the design spec.
 *
 * Core wrappers (safeHandler, safeToolExecute) are imported from events.ts
 * (canonical source). This module provides createToolExecutor convenience wrapper.
 */

import { ExtensionContext } from "../types.js";
import type { ToolResult } from "./guard.js";
import { safeToolExecute } from "../events.js";

// Re-export for backward compatibility
export { safeHandler, safeToolExecute } from "../events.js";

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
