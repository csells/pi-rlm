/**
 * WriteQueue — Serialized async write queue for the ExternalStore.
 * Ensures writes are processed serially even though they're async (NFR-3.4).
 */

/**
 * A single write task to be enqueued.
 */
interface WriteTask {
  name: string;
  fn: () => Promise<void>;
}

/**
 * Manages a serialized queue of async write operations.
 * Ensures that multiple concurrent writes don't interleave or corrupt state.
 */
export class WriteQueue {
  private queue: WriteTask[] = [];
  private processing = false;

  /**
   * Enqueue a write task.
   * The task is added to the queue and will be executed serially.
   * Returns a promise that resolves when the task completes.
   */
  async enqueue(name: string, fn: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({
        name,
        fn: async () => {
          try {
            await fn();
            resolve();
          } catch (err) {
            reject(err);
          }
        },
      });
      this.process();
    });
  }

  /**
   * Process the queue serially.
   * Starts processing if not already processing.
   */
  private async process(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift();
        if (task) {
          try {
            await task.fn();
          } catch (err) {
            console.error(`[pi-rlm] WriteQueue error in task "${task.name}":`, err);
            // Continue processing remaining tasks even if one fails
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Wait for all pending writes to complete.
   * Useful for ensuring data is persisted before shutdown.
   */
  async flush(): Promise<void> {
    // Keep processing until the queue is empty and not currently processing
    return new Promise<void>((resolve) => {
      const checkComplete = () => {
        if (this.queue.length === 0 && !this.processing) {
          resolve();
        } else {
          // Schedule another check
          setImmediate(checkComplete);
        }
      };
      checkComplete();
    });
  }

  /**
   * Get the current queue length (for testing/monitoring).
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Check if currently processing.
   */
  isProcessing(): boolean {
    return this.processing;
  }
}
