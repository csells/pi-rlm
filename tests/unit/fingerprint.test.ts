/**
 * Unit tests for fingerprinting, stub detection, and content analysis.
 * Per §14 (Testing Strategy) and §3.1 of the design spec.
 */

import { describe, it, expect } from "vitest";
import {
  messageFingerprint,
  simpleHash,
  isStubContent,
  inferContentType,
  generateDescription,
  extractContent,
  buildAtomicGroups,
  hasToolCalls,
  AgentMessage,
} from "../../src/context/externalizer.js";

describe("messageFingerprint", () => {
  it("should generate fingerprint from role and timestamp", () => {
    const msg: AgentMessage = {
      role: "user",
      content: "Hello",
      timestamp: 1700000000000,
    };
    expect(messageFingerprint(msg)).toBe("user:1700000000000");
  });

  it("should generate unique fingerprints for different timestamps", () => {
    const msg1: AgentMessage = {
      role: "user",
      content: "Hello",
      timestamp: 1700000000000,
    };
    const msg2: AgentMessage = {
      role: "user",
      content: "Hello",
      timestamp: 1700000000001,
    };
    expect(messageFingerprint(msg1)).not.toBe(messageFingerprint(msg2));
  });

  it("should use toolCallId for toolResult messages", () => {
    const msg: AgentMessage = {
      role: "toolResult",
      content: "Result",
      toolCallId: "call_abc123",
    };
    expect(messageFingerprint(msg)).toBe("toolResult:call_abc123");
  });

  it("should generate fallback fingerprint for messages without timestamp", () => {
    const msg: AgentMessage = {
      role: "user",
      content: "Hello",
    };
    const fp = messageFingerprint(msg);
    expect(fp).toMatch(/^user:fallback:/);
  });

  it("should generate same fingerprint for same content without timestamp", () => {
    const msg: AgentMessage = {
      role: "user",
      content: "Hello world this is a test message",
    };
    const fp1 = messageFingerprint(msg);
    const fp2 = messageFingerprint(msg);
    expect(fp1).toBe(fp2);
  });

  it("should use assistant role for assistant messages", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Response" }],
      timestamp: 1700000000001,
    };
    expect(messageFingerprint(msg)).toBe("assistant:1700000000001");
  });
});

describe("simpleHash", () => {
  it("should generate hash for string", () => {
    const hash = simpleHash("test");
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });

  it("should generate same hash for same input", () => {
    const hash1 = simpleHash("test");
    const hash2 = simpleHash("test");
    expect(hash1).toBe(hash2);
  });

  it("should generate different hashes for different inputs", () => {
    const hash1 = simpleHash("test1");
    const hash2 = simpleHash("test2");
    expect(hash1).not.toBe(hash2);
  });

  it("should handle empty string", () => {
    const hash = simpleHash("");
    expect(hash).toBe("0");
  });
});

describe("isStubContent", () => {
  it("should detect stub content", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: "[RLM externalized: rlm-obj-abc | file | 100 | src/file.ts]",
    };
    expect(isStubContent(msg)).toBe(true);
  });

  it("should not detect non-stub content", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: "This is a normal message",
    };
    expect(isStubContent(msg)).toBe(false);
  });

  it("should handle array content blocks", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "[RLM externalized: rlm-obj-xyz]" }],
    };
    expect(isStubContent(msg)).toBe(true);
  });

  it("should handle messages without content", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [],
    };
    expect(isStubContent(msg)).toBe(false);
  });
});

describe("inferContentType", () => {
  it("should classify tool results as tool_output", () => {
    const msg: AgentMessage = {
      role: "toolResult",
      content: "Command output",
      toolCallId: "call_123",
      toolName: "bash",
    };
    expect(inferContentType(msg)).toBe("tool_output");
  });

  it("should classify rlm_ingest tool results as file", () => {
    const msg: AgentMessage = {
      role: "toolResult",
      content: "Ingested file",
      toolCallId: "call_456",
      toolName: "rlm_ingest",
    };
    expect(inferContentType(msg)).toBe("file");
  });

  it("should classify assistant messages as conversation", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: "Response",
    };
    expect(inferContentType(msg)).toBe("conversation");
  });

  it("should classify user messages as conversation", () => {
    const msg: AgentMessage = {
      role: "user",
      content: "Query",
    };
    expect(inferContentType(msg)).toBe("conversation");
  });

  it("should classify system messages as conversation", () => {
    const msg: AgentMessage = {
      role: "system",
      content: "System instruction",
    };
    expect(inferContentType(msg)).toBe("conversation");
  });
});

describe("generateDescription", () => {
  it("should generate description for user message", () => {
    const msg: AgentMessage = {
      role: "user",
      content: "What is the weather?",
    };
    expect(generateDescription(msg)).toContain("User:");
    expect(generateDescription(msg)).toContain("What is the weather");
  });

  it("should generate description for assistant message", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "The weather is sunny" }],
    };
    expect(generateDescription(msg)).toContain("Assistant:");
    expect(generateDescription(msg)).toContain("The weather is sunny");
  });

  it("should generate description for tool result", () => {
    const msg: AgentMessage = {
      role: "toolResult",
      content: "Command completed",
      toolCallId: "call_123",
      toolName: "bash",
    };
    expect(generateDescription(msg)).toContain("bash:");
    expect(generateDescription(msg)).toContain("Command completed");
  });

  it("should truncate long content", () => {
    const msg: AgentMessage = {
      role: "user",
      content: "a".repeat(200),
    };
    const desc = generateDescription(msg);
    expect(desc.length).toBeLessThan(150);
  });

  it("should handle array content blocks", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "First block " },
        { type: "text", text: "second block" },
      ],
    };
    expect(generateDescription(msg)).toContain("Assistant:");
  });
});

describe("extractContent", () => {
  it("should extract string content directly", () => {
    const msg: AgentMessage = {
      role: "user",
      content: "Hello world",
    };
    expect(extractContent(msg)).toBe("Hello world");
  });

  it("should extract text blocks from array content", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Hello" },
        { type: "text", text: "world" },
      ],
    };
    expect(extractContent(msg)).toBe("Hello\nworld");
  });

  it("should filter out non-text blocks", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Hello" },
        { type: "tool_use", id: "123", name: "tool" },
      ],
    };
    expect(extractContent(msg)).toBe("Hello");
  });

  it("should handle empty content", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [],
    };
    expect(extractContent(msg)).toBe("");
  });
});

describe("hasToolCalls", () => {
  it("should detect tool_use blocks", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "I'll help" },
        { type: "tool_use", id: "call_123", name: "bash" },
      ],
    };
    expect(hasToolCalls(msg)).toBe(true);
  });

  it("should return false for text-only content", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Just text" }],
    };
    expect(hasToolCalls(msg)).toBe(false);
  });

  it("should return false for string content", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: "Just text",
    };
    expect(hasToolCalls(msg)).toBe(false);
  });

  it("should handle empty content", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [],
    };
    expect(hasToolCalls(msg)).toBe(false);
  });
});

describe("buildAtomicGroups", () => {
  it("should group assistant with toolResult", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_123", name: "bash" }],
        timestamp: 1,
      },
      {
        role: "toolResult",
        content: "Output",
        toolCallId: "call_123",
      },
    ];
    const groups = buildAtomicGroups(messages);
    expect(groups.length).toBe(1);
    expect(groups[0].messages.length).toBe(2);
    expect(groups[0].messages[0].role).toBe("assistant");
    expect(groups[0].messages[1].role).toBe("toolResult");
  });

  it("should handle multiple tool calls with results", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "bash" },
          { type: "tool_use", id: "call_2", name: "bash" },
        ],
        timestamp: 1,
      },
      {
        role: "toolResult",
        content: "Output 1",
        toolCallId: "call_1",
      },
      {
        role: "toolResult",
        content: "Output 2",
        toolCallId: "call_2",
      },
    ];
    const groups = buildAtomicGroups(messages);
    expect(groups.length).toBe(1);
    expect(groups[0].messages.length).toBe(3);
  });

  it("should keep standalone messages separate", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Query", timestamp: 1 },
      { role: "assistant", content: "Response", timestamp: 2 },
      { role: "user", content: "Follow-up", timestamp: 3 },
    ];
    const groups = buildAtomicGroups(messages);
    expect(groups.length).toBe(3);
    expect(groups.every((g) => g.messages.length === 1)).toBe(true);
  });

  it("should skip orphaned toolResults", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Query", timestamp: 1 },
      {
        role: "toolResult",
        content: "Output",
        toolCallId: "call_orphaned",
      },
    ];
    const groups = buildAtomicGroups(messages);
    // Only user message should be grouped; orphaned toolResult is skipped
    expect(groups.length).toBe(1);
    expect(groups[0].messages[0].role).toBe("user");
  });

  it("should compute fingerprints for all groups", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Query", timestamp: 1 },
      { role: "assistant", content: "Response", timestamp: 2 },
    ];
    const groups = buildAtomicGroups(messages);
    expect(groups[0].fingerprints.length).toBe(1);
    expect(groups[1].fingerprints.length).toBe(1);
    expect(groups[0].fingerprints[0]).toContain("user:");
    expect(groups[1].fingerprints[0]).toContain("assistant:");
  });

  it("should estimate tokens for groups", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "a".repeat(400), timestamp: 1 },
    ];
    const groups = buildAtomicGroups(messages);
    // 400 chars / 4 = 100 tokens
    expect(groups[0].estimatedTokens).toBe(100);
  });
});
