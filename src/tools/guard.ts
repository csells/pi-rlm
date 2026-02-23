/**
 * Shared tool guard/results helpers.
 * Per §4.1 and §12.1 of the design spec.
 */

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details?: Record<string, unknown>;
}

export interface GuardState {
  enabled: boolean;
}

/**
 * Return an error ToolResult when RLM is disabled.
 * Returns null when tool execution may continue.
 */
export function disabledGuard(state: GuardState): ToolResult | null {
  if (state.enabled) {
    return null;
  }

  return {
    content: [{ type: "text", text: "RLM is disabled. Use /rlm on to enable." }],
    isError: true,
  };
}

/** Create a standardized error ToolResult. */
export function errorResult(message: string, details?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    details,
  };
}

/** Create a standardized success ToolResult. */
export function successResult(text: string, details?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text }],
    details,
  };
}
