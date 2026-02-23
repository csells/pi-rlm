/**
 * Token estimation utilities for Pi-RLM.
 *
 * Provides two token counting functions per §5.1 of the design:
 * - countMessageTokens: chars/4 estimate for normal threshold checks
 * - countMessageTokensSafe: chars/3 estimate for safety valve (conservative)
 *
 * Image blocks are estimated at 1000 tokens each (conservative).
 */

export interface Message {
  role: string;
  content?: string | ContentBlock[];
}

export interface ContentBlock {
  type: string;
  text?: string;
}

/**
 * Count tokens in a message array using chars/4 estimation.
 * Used for the normal externalization threshold check (FR-3.2).
 *
 * Per §5.1:
 * - Text blocks: estimate as character count / 4
 * - Image blocks: not counted (passed through unchanged)
 * - String content: character count / 4
 */
export function countMessageTokens(messages: Message[]): number {
  let total = 0;

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      // String content
      total += Math.ceil(msg.content.length / 4);
    } else if (Array.isArray(msg.content)) {
      // Content blocks
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          total += Math.ceil(block.text.length / 4);
        }
        // Image and other non-text blocks are not counted here
        // (passed through unchanged, not externalized)
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
 */
export function countMessageTokensSafe(messages: Message[]): number {
  let total = 0;

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      // String content
      total += Math.ceil(msg.content.length / 3);
    } else if (Array.isArray(msg.content)) {
      // Content blocks
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          total += Math.ceil(block.text.length / 3);
        } else if (block.type === "image") {
          // Conservative estimate for image blocks
          total += 1000;
        }
        // Other non-text blocks are not counted
      }
    }
  }

  return total;
}
