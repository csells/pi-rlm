/**
 * ExternalStore implementation.
 * Manages externalized content on disk (JSONL) and in memory (cache).
 * Per §11 of the design spec.
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { StoreRecord, StoreIndex, StoreIndexEntry, ContentType, StoreObjectSource } from "../types.js";
import { WriteQueue } from "./write-queue.js";

/**
 * ExternalStore — persists and retrieves externalized content.
 *
 * Data model:
 * - JSONL file: .pi/rlm/<session-id>/store.jsonl (source of truth)
 * - Index: in-memory Map<id, StoreRecord> + index.json (for crash recovery)
 * - Content: cached in memory (fast synchronous access)
 *
 * All writes go through WriteQueue to serialize concurrent updates.
 */
export class ExternalStore {
  private storeDir: string;
  private sessionId: string;
  private records: Map<string, StoreRecord> = new Map();
  private index: StoreIndex;
  private writeQueue: WriteQueue;
  private externalizedMap: Map<string, string> = new Map(); // fingerprint → object ID
  private nextByteOffset: number = 0; // Track current byte position in JSONL file

  constructor(storeDir: string, sessionId: string) {
    this.storeDir = storeDir;
    this.sessionId = sessionId;
    this.writeQueue = new WriteQueue();
    this.index = {
      version: 1,
      sessionId,
      objects: [],
      totalTokens: 0,
    };
  }

  /**
   * Initialize the store — load from disk or create new.
   * Called on session_start (§11.2).
   */
  async initialize(): Promise<void> {
    try {
      await fs.promises.mkdir(this.storeDir, { recursive: true });

      const indexPath = path.join(this.storeDir, "index.json");
      const storePath = path.join(this.storeDir, "store.jsonl");

      // Try to load index
      try {
        const indexData = await fs.promises.readFile(indexPath, "utf-8");
        const loadedIndex = JSON.parse(indexData) as StoreIndex;

        if (loadedIndex.version === 1) {
          this.index = loadedIndex;

          // Load all records from JSONL with crash recovery
          try {
            const data = await fs.promises.readFile(storePath, "utf-8");
            const lines = data.split("\n").filter((line) => line.trim());
            for (let lineNum = 0; lineNum < lines.length; lineNum++) {
              const line = lines[lineNum];
              try {
                const record: StoreRecord = JSON.parse(line);
                this.records.set(record.id, record);
              } catch (parseErr) {
                console.warn(`[pi-rlm] Failed to parse JSONL line ${lineNum + 1}, skipping:`, parseErr);
                // Continue loading remaining lines
              }
            }
            
            // Set nextByteOffset to the file size
            const stat = await fs.promises.stat(storePath);
            this.nextByteOffset = stat.size;
          } catch (err) {
            console.warn("[pi-rlm] Could not load store.jsonl, rebuilding from index", err);
            // Fall back to empty (will rebuild on next write)
            this.nextByteOffset = 0;
          }
        }
      } catch (err) {
        console.log("[pi-rlm] No existing store index, creating new store");
        this.nextByteOffset = 0;
      }

      this.rebuildExternalizedMap();
    } catch (err) {
      console.error("[pi-rlm] Store initialization error:", err);
      throw err;
    }
  }

  /**
   * Get a single record by ID (synchronous).
   */
  get(id: string): StoreRecord | null {
    return this.records.get(id) ?? null;
  }

  /**
   * Get an index entry by ID.
   */
  getIndexEntry(id: string): StoreIndexEntry | null {
    return this.index.objects.find((entry) => entry.id === id) ?? null;
  }

  /**
   * Add a record to the store.
   * Returns the created StoreRecord immediately (sync).
   * Enqueues async JSONL write and index update.
   */
  add(obj: Omit<StoreRecord, "id" | "createdAt">): StoreRecord {
    const id = "rlm-obj-" + randomBytes(4).toString("hex");
    const createdAt = Date.now();
    const record: StoreRecord = { ...obj, id, createdAt };

    // Update in-memory cache
    this.records.set(id, record);

    // Update index - set initial byteOffset/byteLength to -1
    const entry: StoreIndexEntry = {
      id: record.id,
      type: record.type,
      description: record.description,
      tokenEstimate: record.tokenEstimate,
      createdAt: record.createdAt,
      byteOffset: -1, // Will be set on write completion
      byteLength: -1, // Will be set on write completion
    };

    this.index.objects.push(entry);
    this.index.totalTokens += record.tokenEstimate;

    // Enqueue write
    void this.writeQueue.enqueue("store.add", async () => {
      const { byteOffset, byteLength } = await this.writeRecordToJsonl(record);
      
      // Update the index entry with actual byte values
      const indexEntry = this.index.objects.find((e) => e.id === record.id);
      if (indexEntry) {
        indexEntry.byteOffset = byteOffset;
        indexEntry.byteLength = byteLength;
      }
      
      await this.writeIndex();
    });

    return record;
  }

  /**
   * Get all object IDs.
   */
  getAllIds(): string[] {
    return Array.from(this.records.keys());
  }

  /**
   * Get the full store index.
   */
  getFullIndex(): StoreIndex {
    return {
      ...this.index,
      objects: [...this.index.objects],
    };
  }

  /**
   * Find an object by ingest path.
   */
  findByIngestPath(path: string): string | null {
    for (const record of this.records.values()) {
      if (record.source.kind === "ingested" && record.source.path === path) {
        return record.id;
      }
    }
    return null;
  }

  /**
   * Flush all pending writes.
   */
  async flush(): Promise<void> {
    return await this.writeQueue.flush();
  }

  /**
   * Clear all in-memory and on-disk store data for this session.
   */
  async clear(): Promise<void> {
    this.records.clear();
    this.externalizedMap.clear();
    this.index = {
      version: 1,
      sessionId: this.sessionId,
      objects: [],
      totalTokens: 0,
    };

    await this.writeQueue.enqueue("store.clear", async () => {
      const storePath = path.join(this.storeDir, "store.jsonl");
      const indexPath = path.join(this.storeDir, "index.json");

      await fs.promises.rm(storePath, { force: true }).catch(() => {});
      await fs.promises.rm(indexPath, { force: true }).catch(() => {});
      await fs.promises.mkdir(this.storeDir, { recursive: true });
      await this.writeIndex();
    });
  }

  /**
   * Merge records from another session's store.
   * Reads store.jsonl from otherStoreDir, imports records that don't already exist (dedup by record ID),
   * updates in-memory cache and index, and writes merged records to current store's JSONL.
   * Throws if the source directory doesn't exist.
   */
  async mergeFrom(otherStoreDir: string): Promise<void> {
    const otherStorePath = path.join(otherStoreDir, "store.jsonl");
    
    // Check if source directory and file exist
    try {
      await fs.promises.stat(otherStoreDir);
    } catch {
      throw new Error(`Cannot merge from previous session: source directory not found: ${otherStoreDir}`);
    }

    let sourceExists = false;
    try {
      await fs.promises.stat(otherStorePath);
      sourceExists = true;
    } catch {
      // store.jsonl doesn't exist, which is fine (empty previous session)
    }

    if (!sourceExists) {
      // No records to merge
      return;
    }

    // Read and parse the other store's JSONL
    let importedCount = 0;
    try {
      const data = await fs.promises.readFile(otherStorePath, "utf-8");
      const lines = data.split("\n").filter((line) => line.trim());

      for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        try {
          const record: StoreRecord = JSON.parse(line);

          // Skip if we already have this record ID
          if (this.records.has(record.id)) {
            continue;
          }

          // Import the record
          this.records.set(record.id, record);

          // Create index entry
          const entry: StoreIndexEntry = {
            id: record.id,
            type: record.type,
            description: record.description,
            tokenEstimate: record.tokenEstimate,
            createdAt: record.createdAt,
            byteOffset: -1, // Will be set on flush
            byteLength: -1, // Will be set on flush
          };
          this.index.objects.push(entry);
          this.index.totalTokens += record.tokenEstimate;

          importedCount++;

          // Enqueue write for this record
          void this.writeQueue.enqueue("store.merge", async () => {
            const { byteOffset, byteLength } = await this.writeRecordToJsonl(record);
            
            // Update the index entry with actual byte values
            const indexEntry = this.index.objects.find((e) => e.id === record.id);
            if (indexEntry) {
              indexEntry.byteOffset = byteOffset;
              indexEntry.byteLength = byteLength;
            }
          });
        } catch (parseErr) {
          console.warn(`[pi-rlm] Failed to parse JSONL line ${lineNum + 1} from previous session, skipping:`, parseErr);
          // Continue loading remaining lines
        }
      }
    } catch (err) {
      throw new Error(`Failed to read previous session store: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Flush all merged writes and update index
    await this.writeQueue.enqueue("store.merge-finalize", async () => {
      await this.writeIndex();
    });

    console.log(`[pi-rlm] Merged ${importedCount} records from previous session`);
  }

  /**
   * Rebuild the externalized messages map from store records.
   * Called on initialization (§11.2).
   */
  rebuildExternalizedMap(): void {
    this.externalizedMap.clear();
    for (const record of this.records.values()) {
      if (record.source.kind === "externalized") {
        this.externalizedMap.set(record.source.fingerprint, record.id);
      }
    }
  }

  /**
   * Look up an externalized object by message fingerprint.
   */
  getExternalizedId(fingerprint: string): string | null {
    return this.externalizedMap.get(fingerprint) ?? null;
  }

  /**
   * Register an externalized message.
   */
  addExternalized(fingerprint: string, objectId: string): void {
    this.externalizedMap.set(fingerprint, objectId);
  }

  /**
   * Private: Write a record to the JSONL file and track byte offsets.
   */
  private async writeRecordToJsonl(
    record: StoreRecord
  ): Promise<{ byteOffset: number; byteLength: number }> {
    const storePath = path.join(this.storeDir, "store.jsonl");
    const line = JSON.stringify(record) + "\n";
    
    // Capture current offset before writing
    const byteOffset = this.nextByteOffset;
    
    // Compute byte length from the serialized line
    const byteLength = Buffer.byteLength(line, "utf-8");

    try {
      await fs.promises.appendFile(storePath, line, "utf-8");
      
      // Update nextByteOffset after successful write
      this.nextByteOffset += byteLength;
      
      return { byteOffset, byteLength };
    } catch (err) {
      console.error("[pi-rlm] Failed to write to store.jsonl:", err);
      throw err;
    }
  }

  /**
   * Private: Write the index to index.json.
   */
  private async writeIndex(): Promise<void> {
    const indexPath = path.join(this.storeDir, "index.json");

    try {
      await fs.promises.writeFile(indexPath, JSON.stringify(this.index, null, 2), "utf-8");
    } catch (err) {
      console.error("[pi-rlm] Failed to write index.json:", err);
      throw err;
    }
  }
}

/**
 * Helper: Get the RLM store directory for a session.
 */
export function getRlmStoreDir(cwd: string, sessionId: string): string {
  return path.join(cwd, ".pi", "rlm", sessionId);
}
