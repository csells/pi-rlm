/**
 * ConcurrencyLimiter: Promise pool for bounded parallel execution.
 * Per §6.4 and implicit in the batch() design.
 */

export class ConcurrencyLimiter {
  private concurrency: number;

  constructor(concurrency: number = 4) {
    this.concurrency = Math.max(1, Math.floor(concurrency));
  }

  /**
   * Map over an array with concurrency limit.
   * Similar to Promise.all but with a bounded worker pool.
   */
  async map<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
    if (items.length === 0) {
      return [];
    }

    const results = new Array<R>(items.length);
    let nextIndex = 0;

    const worker = async () => {
      while (true) {
        const current = nextIndex++;
        if (current >= items.length) {
          return;
        }

        results[current] = await fn(items[current]!);
      }
    };

    const workerCount = Math.min(this.concurrency, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return results;
  }
}
