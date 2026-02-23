/**
 * ConcurrencyLimiter: Promise pool for bounded parallel execution.
 * Per §6.4 and implicit in the batch() design.
 */

export class ConcurrencyLimiter {
  private concurrency: number;
  private running = 0;
  private queue: Array<() => Promise<void>> = [];

  constructor(concurrency: number = 4) {
    this.concurrency = concurrency;
  }

  /**
   * Map over an array with concurrency limit.
   * Similar to Promise.all but with a bounded queue.
   */
  async map<T, R>(
    items: T[],
    fn: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results: R[] = [];
    let index = 0;

    return new Promise((resolve, reject) => {
      const process = async () => {
        if (index >= items.length) {
          if (this.running === 0) {
            resolve(results);
          }
          return;
        }

        this.running++;
        const currentIndex = index++;

        try {
          const result = await fn(items[currentIndex]);
          results[currentIndex] = result;
        } catch (err) {
          reject(err);
          return;
        }

        this.running--;
        process();
      };

      // Start with up to `concurrency` workers
      for (let i = 0; i < this.concurrency && i < items.length; i++) {
        process();
      }
    });
  }
}
