/**
 * Unit tests for WriteQueue.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WriteQueue } from "../../src/store/write-queue.js";

describe("WriteQueue", () => {
  let queue: WriteQueue;

  beforeEach(() => {
    queue = new WriteQueue();
  });

  describe("enqueue()", () => {
    it("should run a task when enqueued", async () => {
      const fn = vi.fn();
      await queue.enqueue("task-1", async () => {
        fn();
      });

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should execute tasks serially (second task starts after first completes)", async () => {
      const executionOrder: string[] = [];
      let task1Done = false;

      await Promise.all([
        queue.enqueue("task-1", async () => {
          executionOrder.push("task-1-start");
          await new Promise((resolve) => setTimeout(resolve, 10));
          executionOrder.push("task-1-end");
          task1Done = true;
        }),
        queue.enqueue("task-2", async () => {
          // Task 2 should not start until task 1 is done
          expect(task1Done).toBe(true);
          executionOrder.push("task-2-start");
          await new Promise((resolve) => setTimeout(resolve, 5));
          executionOrder.push("task-2-end");
        }),
      ]);

      // Verify order: task-1 fully completes before task-2 starts
      expect(executionOrder[0]).toBe("task-1-start");
      expect(executionOrder[1]).toBe("task-1-end");
      expect(executionOrder[2]).toBe("task-2-start");
      expect(executionOrder[3]).toBe("task-2-end");
    });

    it("should handle multiple concurrent enqueues serially", async () => {
      const order: number[] = [];

      const promises = [];
      for (let i = 1; i <= 5; i++) {
        promises.push(
          queue.enqueue(`task-${i}`, async () => {
            order.push(i);
          }),
        );
      }

      await Promise.all(promises);

      expect(order).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe("flush()", () => {
    it("should resolve when queue is empty", async () => {
      const promise = queue.flush();
      await expect(promise).resolves.toBeUndefined();
    });

    it("should resolve after all enqueued tasks complete", async () => {
      let task1Complete = false;
      let task2Complete = false;

      queue.enqueue("task-1", async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        task1Complete = true;
      });

      queue.enqueue("task-2", async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        task2Complete = true;
      });

      await queue.flush();

      expect(task1Complete).toBe(true);
      expect(task2Complete).toBe(true);
    });

    it("should not block on new enqueues after flush starts", async () => {
      queue.enqueue("task-1", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });

      const flushPromise = queue.flush();

      // Enqueue a new task after flush
      queue.enqueue("task-2", async () => {
        // This should be processed
      });

      // Flush should eventually complete
      await flushPromise;
    });
  });

  describe("Error handling", () => {
    it("should not block subsequent tasks if one errors", async () => {
      const executed: string[] = [];

      const promises = [
        queue.enqueue("task-1", async () => {
          executed.push("task-1");
          throw new Error("Task 1 failed");
        }),
        queue.enqueue("task-2", async () => {
          executed.push("task-2");
        }),
      ];

      // task-1 rejects, but task-2 should still execute
      const results = await Promise.allSettled(promises);

      expect(results[0].status).toBe("rejected");
      expect(results[1].status).toBe("fulfilled");
      expect(executed).toContain("task-1");
      expect(executed).toContain("task-2");
    });

    it("should continue processing remaining tasks after error", async () => {
      const executed: string[] = [];

      const promises = [
        queue.enqueue("task-1", async () => {
          executed.push("task-1");
        }),
        queue.enqueue("task-2", async () => {
          executed.push("task-2");
          throw new Error("Task 2 failed");
        }),
        queue.enqueue("task-3", async () => {
          executed.push("task-3");
        }),
      ];

      // Wait for all to settle (task-2 may reject)
      const results = await Promise.allSettled(promises);

      // All tasks should be executed despite task-2 error
      expect(executed).toEqual(["task-1", "task-2", "task-3"]);
      expect(results[1].status).toBe("rejected"); // task-2 rejected
    });
  });

  describe("getQueueLength()", () => {
    it("should track pending queue length", async () => {
      expect(queue.getQueueLength()).toBe(0);

      const slowTask = new Promise<void>((resolve) => {
        queue.enqueue("slow-task", async () => {
          await new Promise((r) => setTimeout(r, 50));
          resolve();
        });
      });

      // Immediately enqueue fast tasks while slow is processing
      queue.enqueue("fast-1", async () => {});
      queue.enqueue("fast-2", async () => {});

      // Length should be > 0 while processing
      expect(queue.getQueueLength()).toBeGreaterThan(0);

      await slowTask;
      await queue.flush();

      expect(queue.getQueueLength()).toBe(0);
    });

    it("should return 0 when queue is empty", () => {
      expect(queue.getQueueLength()).toBe(0);
    });

    it("should accurately report queue length during processing", async () => {
      const lengths: number[] = [];
      const checkpoints: string[] = [];

      queue.enqueue("task-1", async () => {
        checkpoints.push("task-1-start");
        lengths.push(queue.getQueueLength());
        // Keep task-1 running while other tasks are enqueued
        await new Promise((resolve) => setTimeout(resolve, 50));
        checkpoints.push("task-1-end");
      });

      // Enqueue more tasks quickly before task-1 completes
      // Use synchronous approach instead of awaiting task-1
      for (let i = 2; i <= 4; i++) {
        queue.enqueue(`task-${i}`, async () => {
          checkpoints.push(`task-${i}`);
          lengths.push(queue.getQueueLength());
        });
      }

      await queue.flush();

      // Should have captured queue lengths
      expect(lengths.length).toBeGreaterThan(0);
      // At least one task should observe a non-zero queue length
      expect(lengths.some((len) => len > 0)).toBe(true);
    });
  });

  describe("isProcessing()", () => {
    it("should return true while processing tasks", async () => {
      expect(queue.isProcessing()).toBe(false);

      const processing: boolean[] = [];

      queue.enqueue("task-1", async () => {
        processing.push(queue.isProcessing());
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      // Check state immediately
      expect(queue.isProcessing()).toBe(true);

      await queue.flush();

      expect(queue.isProcessing()).toBe(false);
      // Task should have seen isProcessing() = true
      expect(processing[0]).toBe(true);
    });

    it("should return false when idle", async () => {
      expect(queue.isProcessing()).toBe(false);

      await queue.enqueue("task-1", async () => {});

      // After processing completes
      expect(queue.isProcessing()).toBe(false);
    });

    it("should reflect state during queue processing", async () => {
      const states: boolean[] = [];

      queue.enqueue("task-1", async () => {
        states.push(queue.isProcessing());
        await new Promise((resolve) => setTimeout(resolve, 5));
      });

      queue.enqueue("task-2", async () => {
        states.push(queue.isProcessing());
      });

      states.push(queue.isProcessing());
      await queue.flush();
      states.push(queue.isProcessing());

      // task-1 and task-2 should see isProcessing() = true
      expect(states[0]).toBe(true); // isProcessing() called before enqueue
      expect(states[1]).toBe(true); // Inside task-1
      expect(states[2]).toBe(true); // Inside task-2
      expect(states[3]).toBe(false); // After flush
    });
  });

  describe("Task execution semantics", () => {
    it("should preserve task order strictly", async () => {
      const results: number[] = [];

      const promises = [];
      for (let i = 1; i <= 10; i++) {
        promises.push(
          queue.enqueue(`task-${i}`, async () => {
            results.push(i);
          }),
        );
      }

      await Promise.all(promises);

      expect(results).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it("should resolve promise for each task individually", async () => {
      let task1Resolved = false;
      let task2Resolved = false;

      const p1 = queue.enqueue("task-1", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        task1Resolved = true;
      });

      const p2 = queue.enqueue("task-2", async () => {
        task2Resolved = true;
      });

      // Check after enqueueing but before awaiting
      expect(queue.getQueueLength()).toBeGreaterThan(0);

      await p1;
      expect(task1Resolved).toBe(true);
      // task-2 might not be resolved yet depending on timing
      // But we can verify the promise behavior
      const task2Promise = Promise.race([
        p2,
        new Promise((resolve) => setTimeout(resolve, 100, "timeout")),
      ]);

      const result = await task2Promise;
      expect(result).not.toBe("timeout"); // p2 should resolve
      expect(task2Resolved).toBe(true);
    });

    it("should handle async operations within tasks", async () => {
      const results: string[] = [];

      await queue.enqueue("task-1", async () => {
        results.push("start-1");
        await new Promise((resolve) => setTimeout(resolve, 10));
        results.push("end-1");
      });

      await queue.enqueue("task-2", async () => {
        results.push("start-2");
        await new Promise((resolve) => setTimeout(resolve, 5));
        results.push("end-2");
      });

      expect(results).toEqual(["start-1", "end-1", "start-2", "end-2"]);
    });
  });
});
