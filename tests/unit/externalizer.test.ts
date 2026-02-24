/**
 * Unit tests for context externalization handlers and algorithms.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config.js";
import {
  AgentMessage,
  externalize,
  ExternalizerState,
  forceExternalize,
  messageFingerprint,
  onBeforeCompact,
  onContext,
  replaceContentWithStub,
  replaceExternalizedWithStubs,
} from "../../src/context/externalizer.js";
import { ManifestBuilder } from "../../src/context/manifest.js";
import { WarmTracker } from "../../src/context/warm-tracker.js";
import { IExternalStore, StoreIndex, StoreIndexEntry, StoreRecord } from "../../src/types.js";

class MockStore implements IExternalStore {
  private records = new Map<string, StoreRecord>();
  private ids: string[] = [];
  private seq = 0;
  private externalizedMap = new Map<string, string>();

  get(id: string): StoreRecord | null {
    return this.records.get(id) ?? null;
  }

  getIndexEntry(id: string): StoreIndexEntry | null {
    const rec = this.records.get(id);
    if (!rec) return null;
    return {
      id: rec.id,
      type: rec.type,
      description: rec.description,
      tokenEstimate: rec.tokenEstimate,
      createdAt: rec.createdAt,
      byteOffset: 0,
      byteLength: rec.content.length,
    };
  }

  add(obj: Omit<StoreRecord, "id" | "createdAt">): StoreRecord {
    const rec: StoreRecord = {
      ...obj,
      id: `rlm-obj-${String(this.seq++).padStart(4, "0")}`,
      createdAt: Date.now(),
    };
    this.records.set(rec.id, rec);
    this.ids.push(rec.id);
    return rec;
  }

  getAllIds(): string[] {
    return [...this.ids];
  }

  getFullIndex(): StoreIndex {
    const objects = this.ids
      .map((id) => this.getIndexEntry(id))
      .filter((entry): entry is StoreIndexEntry => entry !== null);

    return {
      version: 1,
      sessionId: "test",
      objects,
      totalTokens: objects.reduce((sum, o) => sum + o.tokenEstimate, 0),
    };
  }

  findByIngestPath(path: string): string | null {
    for (const id of this.ids) {
      const rec = this.records.get(id);
      if (rec?.source.kind === "ingested" && rec.source.path === path) {
        return id;
      }
    }
    return null;
  }

  async initialize(): Promise<void> {
    // no-op
  }

  async flush(): Promise<void> {
    // no-op
  }

  rebuildExternalizedMap(): void {
    this.externalizedMap.clear();
    for (const id of this.ids) {
      const rec = this.records.get(id);
      if (rec?.source.kind === "externalized" && rec.source.fingerprint) {
        this.externalizedMap.set(rec.source.fingerprint, rec.id);
      }
    }
  }

  getExternalizedId(fingerprint: string): string | null {
    return this.externalizedMap.get(fingerprint) ?? null;
  }

  addExternalized(fingerprint: string, objectId: string): void {
    this.externalizedMap.set(fingerprint, objectId);
  }
}

function createState(store: MockStore): ExternalizerState {
  return {
    enabled: true,
    config: {
      ...DEFAULT_CONFIG,
      tokenBudgetPercent: 60,
      safetyValvePercent: 90,
      manifestBudget: 400,
    },
    store,
    manifest: new ManifestBuilder(store),
    warmTracker: new WarmTracker(3),
    activePhases: new Set<string>(),
    turnCount: 0,
    storeHealthy: true,
    allowCompaction: false,
    forceExternalizeOnNextTurn: false,
    trajectory: {
      append: vi.fn(),
      flush: async () => {},
    },
    updateWidget: vi.fn(),
  };
}

describe("externalizer algorithms", () => {
  beforeEach(() => {
    // Store now manages externalized messages internally
  });

  it("replaceContentWithStub preserves assistant tool_use blocks", () => {
    const msg: AgentMessage = {
      role: "assistant",
      timestamp: 1,
      content: [{ type: "tool_use", id: "call-1", name: "bash" }],
    };

    replaceContentWithStub(msg, {
      id: "rlm-obj-0001",
      type: "tool_output",
      tokenEstimate: 123,
      description: "bash output",
    });

    expect(Array.isArray(msg.content)).toBe(true);
    const blocks = msg.content as Array<{ type: string; text?: string; id?: string }>;
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toContain("rlm-obj-0001");
    expect(blocks[1].type).toBe("tool_use");
    expect(blocks[1].id).toBe("call-1");
  });

  it("replaceExternalizedWithStubs replaces known fingerprints", () => {
    const store = new MockStore();
    const msg: AgentMessage = {
      role: "assistant",
      timestamp: 10,
      content: "original text",
    };

    const rec = store.add({
      type: "conversation",
      description: "Assistant: original text",
      tokenEstimate: 5,
      content: "original text",
      source: { kind: "externalized", fingerprint: messageFingerprint(msg) },
    });
    store.addExternalized(messageFingerprint(msg), rec.id);

    replaceExternalizedWithStubs([msg], store);

    expect(Array.isArray(msg.content)).toBe(true);
    const blocks = msg.content as Array<{ type: string; text?: string }>;
    expect(blocks[0].text).toContain("[RLM externalized:");
    expect(blocks[0].text).toContain(rec.id);
  });

  it("externalize() skips newest user/assistant and externalizes eligible atomic groups", () => {
    const store = new MockStore();
    const state = createState(store);

    const messages: AgentMessage[] = [
      {
        role: "assistant",
        timestamp: 1,
        content: [
          { type: "text", text: "running tool" },
          { type: "tool_use", id: "call-1", name: "bash" },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: "x".repeat(2000),
      },
      {
        role: "assistant",
        timestamp: 3,
        content: "latest assistant",
      },
      {
        role: "user",
        timestamp: 4,
        content: "latest user",
      },
    ];

    const result = externalize(messages, state, 100);

    expect(result.objectIds.length).toBe(2);
    expect(store.getFullIndex().objects.length).toBe(2);

    // Older assistant should now be stubbed.
    const firstBlocks = messages[0].content as Array<{ type: string; text?: string }>;
    expect(firstBlocks[0].text).toContain("[RLM externalized:");

    // Most recent messages are not externalized.
    expect(messages[2].content).toBe("latest assistant");
    expect(messages[3].content).toBe("latest user");
  });

  it("externalize() skips warm tool results", () => {
    const store = new MockStore();
    const state = createState(store);
    state.warmTracker.markToolCallWarm("call-warm");

    const messages: AgentMessage[] = [
      {
        role: "assistant",
        timestamp: 1,
        content: [{ type: "tool_use", id: "call-warm", name: "bash" }],
      },
      {
        role: "toolResult",
        toolCallId: "call-warm",
        toolName: "bash",
        content: "x".repeat(2000),
      },
      {
        role: "assistant",
        timestamp: 2,
        content: "latest assistant",
      },
      {
        role: "user",
        timestamp: 3,
        content: "latest user",
      },
    ];

    const result = externalize(messages, state, 100);

    expect(result.objectIds.length).toBe(0);
    expect(store.getFullIndex().objects.length).toBe(0);
  });

  it("forceExternalize() skips system + newest messages", () => {
    const store = new MockStore();
    const state = createState(store);

    const messages: AgentMessage[] = [
      { role: "system", timestamp: 1, content: "system prompt" },
      { role: "user", timestamp: 2, content: "older user content " + "x".repeat(1200) },
      { role: "assistant", timestamp: 3, content: "older assistant " + "y".repeat(1200) },
      { role: "assistant", timestamp: 4, content: "latest assistant " + "z".repeat(1200) },
      { role: "user", timestamp: 5, content: "latest user " + "w".repeat(1200) },
    ];

    const result = forceExternalize(messages, state);

    expect(result.objectIds.length).toBe(2);
    expect(store.getFullIndex().objects.length).toBe(2);

    expect(messages[0].content).toBe("system prompt");
    expect(messages[3].content).toContain("latest assistant");
    expect(messages[4].content).toContain("latest user");

    const olderUserBlocks = messages[1].content as Array<{ type: string; text?: string }>;
    expect(olderUserBlocks[0].text).toContain("[RLM externalized:");
  });
});

describe("context handlers", () => {
  beforeEach(() => {
    // Store now manages externalized messages internally
  });

  it("onContext performs phase-0 stub replacement even when tokens are null", async () => {
    const store = new MockStore();
    const state = createState(store);

    const oldAssistant: AgentMessage = {
      role: "assistant",
      timestamp: 10,
      content: "old assistant content",
    };

    const rec = store.add({
      type: "conversation",
      description: "old assistant",
      tokenEstimate: 10,
      content: "old assistant content",
      source: { kind: "externalized", fingerprint: messageFingerprint(oldAssistant) },
    });
    store.addExternalized(messageFingerprint(oldAssistant), rec.id);

    const result = await onContext(
      {
        messages: [
          oldAssistant,
          { role: "user", timestamp: 11, content: "new user message" },
        ],
      },
      {
        getContextUsage: () => ({ tokens: null, contextWindow: 1000 }),
      } as any,
      state,
    );

    expect(result).toBeDefined();
    const blocks = result!.messages[0].content as Array<{ type: string; text?: string }>;
    expect(blocks[0].text).toContain("[RLM externalized:");
  });

  it("onContext injects manifest into first user message when store has objects", async () => {
    const store = new MockStore();
    const state = createState(store);

    store.add({
      type: "file",
      description: "src/a.ts",
      tokenEstimate: 100,
      content: "export const a = 1;",
      source: { kind: "ingested", path: "src/a.ts" },
    });

    const result = await onContext(
      { messages: [{ role: "user", timestamp: 1, content: "hello" }] },
      {
        getContextUsage: () => ({ tokens: null, contextWindow: 1000 }),
      } as any,
      state,
    );

    expect(typeof result?.messages[0].content).toBe("string");
    expect(result?.messages[0].content).toContain("## RLM External Context");
    expect(result?.messages[0].content).toContain("hello");
  });

  it("onContext enables allowCompaction when safety valve cannot reduce context", async () => {
    const store = new MockStore();
    const state = createState(store);

    const messages: AgentMessage[] = [
      {
        role: "assistant",
        timestamp: 1,
        content: "a".repeat(4000),
      },
      {
        role: "user",
        timestamp: 2,
        content: "b".repeat(4000),
      },
    ];

    await onContext(
      { messages },
      {
        getContextUsage: () => ({ tokens: 950, contextWindow: 1000 }),
        model: { id: "test-model" },
      } as any,
      state,
    );

    // Both messages are the most recent assistant/user so force pass cannot shrink enough.
    expect(state.allowCompaction).toBe(true);
    expect(store.getFullIndex().objects.length).toBe(0);
  });

  it("onBeforeCompact cancels by default but respects allowCompaction safety valve", async () => {
    const cancel = await onBeforeCompact(
      {},
      {} as any,
      { enabled: true, storeHealthy: true, allowCompaction: false },
    );
    expect(cancel).toEqual({ cancel: true });

    const allow = { enabled: true, storeHealthy: true, allowCompaction: true };
    const passThrough = await onBeforeCompact({}, {} as any, allow);
    expect(passThrough).toBeUndefined();
    expect(allow.allowCompaction).toBe(false);
  });
});
