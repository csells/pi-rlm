/**
 * Token estimation utilities for Pi-RLM.
 *
 * Provides two token counting functions per §5.1 of the design:
 * - countMessageTokens: chars/4 estimate for normal threshold checks
 * - countMessageTokensSafe: chars/3 estimate for safety valve (conservative)
 *
 * Image blocks are estimated at 1000 tokens each (conservative).
 *
 * When a TokenOracle is provided and warmed (10+ observations), uses oracle estimates
 * instead of hardcoded ratios.
 */

import type { ITokenOracle } from "../types.js";

export interface Message {
  role: string;
  content?: string | ContentBlock[];
}

export interface ContentBlock {
  type: string;
  text?: string;
}

// Re-export ITokenOracle for convenience
export type { ITokenOracle };

/**
 * Count tokens in a message array using chars/4 estimation.
 * Used for the normal externalization threshold check (FR-3.2).
 *
 * Per §5.1:
 * - Text blocks: estimate as character count / 4
 * - Image blocks: not counted (passed through unchanged)
 * - String content: character count / 4
 *
 * When oracle is provided and warmed (10+ observations), uses oracle.estimate()
 * instead of hardcoded ratio.
 *
 * @param messages - Message array to count
 * @param oracle - Optional TokenOracle for self-calibrating estimates
 */
export function countMessageTokens(messages: Message[], oracle?: ITokenOracle): number {
  let total = 0;
  let totalChars = 0;

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      totalChars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          totalChars += block.text.length;
        }
      }
    }
  }

  // Use oracle estimate if available and warmed
  if (oracle && !oracle.isCold()) {
    return oracle.estimate(totalChars);
  }

  // Fallback to chars/4
  total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += Math.ceil(msg.content.length / 4);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          total += Math.ceil(block.text.length / 4);
        }
      }
    }
  }

  return total;
}

/**
 * Count tokens in a message array using chars/3 estimation (conservative).
 * Used for the safety valve threshold check (FR-3.8).
 *
 * More conservative than countMessageTokens to ensure safety valve
 * triggers earlier rather than later, preventing context overflow.
 *
 * Per §5.1:
 * - Text blocks: estimate as character count / 3 (more conservative)
 * - Image blocks: estimate as 1000 tokens each (conservative)
 * - String content: character count / 3
 *
 * When oracle is provided and warmed (10+ observations), uses oracle.estimateSafe()
 * instead of hardcoded chars/3 ratio.
 *
 * @param messages - Message array to count
 * @param oracle - Optional TokenOracle for self-calibrating estimates
 */
export function countMessageTokensSafe(messages: Message[], oracle?: ITokenOracle): number {
  let total = 0;
  let totalChars = 0;
  let imageCount = 0;

  // First pass: count characters and images
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      totalChars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          totalChars += block.text.length;
        } else if (block.type === "image") {
          imageCount += 1;
        }
      }
    }
  }

  // Use oracle estimate if available and warmed
  if (oracle && !oracle.isCold()) {
    total = oracle.estimateSafe(totalChars);
  } else {
    // Fallback to chars/3
    total = Math.ceil(totalChars / 3);
  }

  // Add image tokens (conservative: 1000 per image)
  total += imageCount * 1000;

  return total;
}
