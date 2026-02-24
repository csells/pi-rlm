/**
 * Factory functions for creating test messages of different types.
 * Provides consistent message creation patterns across test files.
 */

import { AgentMessage } from "../../src/context/externalizer.js";

/**
 * Create a user message.
 * @param content The message content (text string or content blocks array)
 * @param timestamp Optional timestamp (defaults to current time)
 */
export function userMsg(
  content: string | Array<{ type: string; [key: string]: any }>,
  timestamp?: number,
): AgentMessage {
  return {
    role: "user",
    content,
    timestamp: timestamp ?? Date.now(),
  };
}

/**
 * Create an assistant message.
 * @param content The message content (text string or content blocks array)
 * @param timestamp Optional timestamp (defaults to current time)
 */
export function assistantMsg(
  content: string | Array<{ type: string; [key: string]: any }>,
  timestamp?: number,
): AgentMessage {
  return {
    role: "assistant",
    content,
    timestamp: timestamp ?? Date.now(),
  };
}

/**
 * Create a system message.
 * @param content The message content
 * @param timestamp Optional timestamp (defaults to current time)
 */
export function systemMsg(content: string, timestamp?: number): AgentMessage {
  return {
    role: "system",
    content,
    timestamp: timestamp ?? Date.now(),
  };
}

/**
 * Create a tool result message.
 * @param toolCallId The ID of the tool call this result is for
 * @param toolName The name of the tool
 * @param content The tool output content
 * @param timestamp Optional timestamp (defaults to current time)
 */
export function toolResultMsg(
  toolCallId: string,
  toolName: string,
  content: string,
  timestamp?: number,
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content,
    timestamp: timestamp ?? Date.now(),
  };
}

/**
 * Create a large tool result message with repeated content.
 * Useful for testing large message handling and externalization.
 * @param toolCallId The ID of the tool call this result is for
 * @param toolName The name of the tool
 * @param repeatChar The character to repeat
 * @param count The number of times to repeat the character
 * @param timestamp Optional timestamp (defaults to current time)
 */
export function largeToolResult(
  toolCallId: string,
  toolName: string,
  repeatChar: string,
  count: number,
  timestamp?: number,
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: repeatChar.repeat(count),
    timestamp: timestamp ?? Date.now(),
  };
}
