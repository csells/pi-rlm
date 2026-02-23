/**
 * TrajectoryLogger — Append-only JSONL trajectory writer for Pi-RLM.
 *
 * Per §3.6, logs all RLM operations (recursive calls, searches, ingestion, etc.)
 * to .pi/rlm/<session-id>/trajectory.jsonl for observability (NFR-4.1).
 *
 * Uses WriteQueue for serialized async writes to prevent interleaving.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { WriteQueue } from "./store/write-queue.js";
import type { TrajectoryRecord } from "./types.js";

/**
 * Manages append-only JSONL trajectory logging for all RLM operations.
 *
 * Records are written asynchronously via a WriteQueue to ensure serial writes
 * and prevent corruption from concurrent operations.
 *
 * Location: .pi/rlm/<session-id>/trajectory.jsonl
 */
export class TrajectoryLogger {
  private storePath: string;
  private trajectoryPath: string;
  private writeQueue = new WriteQueue();
  private pendingRecords: TrajectoryRecord[] = [];

  /**
   * Create a new TrajectoryLogger.
   *
   * @param storePath - The store directory path (e.g., ".pi/rlm/session-123")
   */
  constructor(storePath: string) {
    this.storePath = storePath;
    this.trajectoryPath = path.join(storePath, "trajectory.jsonl");
  }

  /**
   * Append a trajectory record to the pending queue.
   *
   * Records are batched and written asynchronously by flush().
   * Does not block — returns immediately.
   *
   * @param record - The trajectory record to append
   */
  append(record: TrajectoryRecord): void {
    this.pendingRecords.push(record);
  }

  /**
   * Flush all pending records to disk.
   *
   * Writes all pending records to the trajectory.jsonl file as JSONL
   * (one JSON object per line). Runs through the WriteQueue to ensure
   * serialization with other store writes.
   *
   * Clears the pending queue after a successful write.
   * If the write fails, the queue is cleared anyway to prevent memory
   * accumulation (the error is logged and returned).
   */
  async flush(): Promise<void> {
    if (this.pendingRecords.length === 0) {
      return;
    }

    const recordsToWrite = this.pendingRecords;
    this.pendingRecords = [];

    await this.writeQueue.enqueue("trajectory.flush", async () => {
      // Ensure directory exists
      await fs.promises.mkdir(this.storePath, { recursive: true });

      // Append records as JSONL
      const lines = recordsToWrite
        .map((record) => JSON.stringify(record))
        .join("\n");

      // Append to the file (create if doesn't exist)
      await fs.promises.appendFile(this.trajectoryPath, lines + "\n");
    });
  }

  /**
   * Get the trajectory file path (for testing/inspection).
   */
  getTrajectoryPath(): string {
    return this.trajectoryPath;
  }

  /**
   * Get the number of pending records waiting to be flushed.
   */
  getPendingCount(): number {
    return this.pendingRecords.length;
  }
}
