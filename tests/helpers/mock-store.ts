/**
 * Mock implementation of IExternalStore for testing.
 * Provides in-memory storage for test objects without persistence.
 */

import { IExternalStore, StoreIndex, StoreIndexEntry, StoreRecord } from "../../src/types.js";

export class MockStore implements IExternalStore {
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
