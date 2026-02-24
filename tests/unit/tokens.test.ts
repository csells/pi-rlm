/**
 * Unit tests for token counting functions.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { countMessageTokens, countMessageTokensSafe, type Message } from "../../src/context/tokens.js";
import { TokenOracle } from "../../src/context/token-oracle.js";

describe("countMessageTokens", () => {
  it("should count string content as chars/4", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: "hello world", // 11 chars
      },
    ];

    const tokens = countMessageTokens(messages);
    // ceil(11 / 4) = 3
    expect(tokens).toBe(3);
  });

  it("should count array content blocks with text", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "hello world" }, // 11 chars
          { type: "text", text: "foo" }, // 3 chars
        ],
      },
    ];

    const tokens = countMessageTokens(messages);
    // ceil(11 / 4) + ceil(3 / 4) = 3 + 1 = 4
    expect(tokens).toBe(4);
  });

  it("should handle mixed text and image content blocks", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "describe this image" }, // 19 chars
          { type: "image" }, // images not counted in countMessageTokens
        ],
      },
    ];

    const tokens = countMessageTokens(messages);
    // ceil(19 / 4) = 5 (images ignored)
    expect(tokens).toBe(5);
  });

  it("should handle empty array content", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [],
      },
    ];

    const tokens = countMessageTokens(messages);
    expect(tokens).toBe(0);
  });

  it("should handle message with no content field", () => {
    const messages: Message[] = [
      {
        role: "user",
      },
    ];

    const tokens = countMessageTokens(messages);
    expect(tokens).toBe(0);
  });

  it("should sum tokens across multiple messages", () => {
    const messages: Message[] = [
      { role: "user", content: "hello" }, // 5 chars: ceil(5/4) = 2
      { role: "assistant", content: "world" }, // 5 chars: ceil(5/4) = 2
    ];

    const tokens = countMessageTokens(messages);
    expect(tokens).toBe(4);
  });
});

describe("countMessageTokensSafe", () => {
  it("should count string content as chars/3", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: "hello world", // 11 chars
      },
    ];

    const tokens = countMessageTokensSafe(messages);
    // ceil(11 / 3) = 4
    expect(tokens).toBe(4);
  });

  it("should add 1000 tokens per image block", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "describe" }, // 8 chars: ceil(8/3) = 3
          { type: "image" }, // 1000 tokens
          { type: "image" }, // 1000 tokens
        ],
      },
    ];

    const tokens = countMessageTokensSafe(messages);
    // 3 + 1000 + 1000 = 2003
    expect(tokens).toBe(2003);
  });

  it("should be conservative: >= chars/4 estimate", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: "test content here", // 17 chars
      },
    ];

    const normal = countMessageTokens(messages);
    const safe = countMessageTokensSafe(messages);

    // ceil(17/4) = 5, ceil(17/3) = 6
    expect(normal).toBe(5);
    expect(safe).toBe(6);
    expect(safe).toBeGreaterThanOrEqual(normal);
  });

  it("should handle no images", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "text only" }],
      },
    ];

    const tokens = countMessageTokensSafe(messages);
    // ceil(9 / 3) = 3
    expect(tokens).toBe(3);
  });
});

describe("countMessageTokens with TokenOracle", () => {
  it("should use oracle.estimate() when oracle is warmed", () => {
    const oracle = new TokenOracle();
    // Warm up oracle with observations showing ratio of 2
    for (let i = 0; i < 10; i++) {
      oracle.observe(200, 100); // ratio: 2
    }

    const messages: Message[] = [
      {
        role: "user",
        content: "x".repeat(200), // 200 chars
      },
    ];

    const tokens = countMessageTokens(messages, oracle);
    // With warmed oracle at ratio 2: 200 / 2 = 100
    expect(tokens).toBe(100);
  });

  it("should use fallback chars/4 when oracle is cold", () => {
    const oracle = new TokenOracle();
    // Oracle is cold initially

    const messages: Message[] = [
      {
        role: "user",
        content: "x".repeat(400), // 400 chars
      },
    ];

    const tokens = countMessageTokens(messages, oracle);
    // Cold fallback: ceil(400 / 4) = 100
    expect(tokens).toBe(100);
  });
});

describe("countMessageTokensSafe with TokenOracle", () => {
  it("should use oracle.estimateSafe() when oracle is warmed", () => {
    const oracle = new TokenOracle();
    // Warm up oracle with consistent observations
    for (let i = 0; i < 10; i++) {
      oracle.observe(300, 100); // ratio: 3
    }

    const messages: Message[] = [
      {
        role: "user",
        content: "x".repeat(300), // 300 chars
      },
    ];

    const tokens = countMessageTokensSafe(messages, oracle);
    // With warmed oracle: estimateSafe uses mean ratio + quantile
    // Should be >= 100 (300 / 3)
    expect(tokens).toBeGreaterThanOrEqual(100);
  });

  it("should use fallback chars/3 when oracle is cold", () => {
    const oracle = new TokenOracle();
    // Oracle is cold

    const messages: Message[] = [
      {
        role: "user",
        content: "x".repeat(300), // 300 chars
      },
    ];

    const tokens = countMessageTokensSafe(messages, oracle);
    // Cold fallback: ceil(300 / 3) = 100
    expect(tokens).toBe(100);
  });

  it("should add images even with warm oracle", () => {
    const oracle = new TokenOracle();
    for (let i = 0; i < 10; i++) {
      oracle.observe(100, 50);
    }

    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "x".repeat(300) }, // 300 chars
          { type: "image" }, // 1000 tokens per image
          { type: "image" },
        ],
      },
    ];

    const tokens = countMessageTokensSafe(messages, oracle);
    // estimateSafe(300) + 2000 (2 images)
    const baseEst = oracle.estimateSafe(300);
    expect(tokens).toBe(baseEst + 2000);
  });

  it("should compare safe vs normal with oracle", () => {
    const oracle = new TokenOracle();
    for (let i = 0; i < 10; i++) {
      oracle.observe(400, 100);
    }

    const messages: Message[] = [
      {
        role: "user",
        content: "x".repeat(400),
      },
    ];

    const normal = countMessageTokens(messages, oracle);
    const safe = countMessageTokensSafe(messages, oracle);

    // Safe should be >= normal (includes quantile margin)
    expect(safe).toBeGreaterThanOrEqual(normal);
  });
});

describe("Edge cases", () => {
  it("should handle very large content", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: "x".repeat(100000), // 100k chars
      },
    ];

    const normal = countMessageTokens(messages);
    const safe = countMessageTokensSafe(messages);

    expect(normal).toBeGreaterThan(0);
    expect(safe).toBeGreaterThan(0);
    expect(safe).toBeGreaterThanOrEqual(normal);
  });

  it("should handle content blocks without text field", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text" }, // No text field
          { type: "other" }, // Unknown type
        ],
      },
    ];

    const tokens = countMessageTokens(messages);
    expect(tokens).toBe(0);
  });

  it("should handle null/undefined messages gracefully", () => {
    const messages: Message[] = [
      { role: "user", content: undefined },
      { role: "assistant", content: null as any },
    ];

    const tokens = countMessageTokens(messages);
    expect(tokens).toBe(0);
  });
});
