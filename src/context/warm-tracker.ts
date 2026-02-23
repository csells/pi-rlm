/**
 * WarmTracker: Dual tracking of warm object IDs and tool call IDs.
 *
 * Per §5.2.2 and FR-3.9, WarmTracker prevents re-externalization thrashing
 * by tracking recently-retrieved objects and tool call results.
 *
 * When rlm_peek executes:
 * 1. It calls warmTracker.markWarm([targetId]) — source object stays in context
 * 2. It calls warmTracker.markToolCallWarm(toolCallId) — result stays in context
 * 3. On next context event, externalization skips warm objects/results
 * 4. After warmTurns ticks, the objects cool and can be externalized again
 *
 * This breaks the retrieve→externalize→retrieve cycle (C5 fix).
 */

/**
 * WarmTracker class implementing IWarmTracker.
 *
 * Dual Maps track warm references with countdown timers:
 * - warmObjects: Map<objectId, remainingTurns>
 * - warmToolCalls: Map<toolCallId, remainingTurns>
 *
 * The tick() method decrements counters each turn; entries expire at 0.
 */
export class WarmTracker {
  private warmObjects = new Map<string, number>();
  private warmToolCalls = new Map<string, number>();
  private warmTurns: number;

  /**
   * Create a WarmTracker.
   *
   * @param warmTurns - Number of turns to keep objects/results warm (default: 3)
   */
  constructor(warmTurns: number = 3) {
    this.warmTurns = warmTurns;
  }

  /**
   * Mark store object IDs as warm to prevent their externalization.
   *
   * Called when rlm_peek or other retrieval tools execute. Prevents the
   * source object from being externalized in the next context event.
   *
   * @param objectIds - Array of store object IDs to mark warm
   */
  markWarm(objectIds: string[]): void {
    for (const id of objectIds) {
      this.warmObjects.set(id, this.warmTurns);
    }
  }

  /**
   * Mark an RLM tool call result as warm to prevent its externalization.
   *
   * Called when rlm_peek or other tools execute. Prevents the tool result
   * message from being externalized in the next context event. This is
   * keyed by the tool call's ID.
   *
   * @param toolCallId - The tool call ID (message.toolCallId)
   */
  markToolCallWarm(toolCallId: string): void {
    this.warmToolCalls.set(toolCallId, this.warmTurns);
  }

  /**
   * Check if a store object is currently warm.
   *
   * Returns true if the object has been marked warm and has not yet cooled.
   * Used by externalization algorithm to skip warm objects.
   *
   * @param objectId - The store object ID
   * @returns true if the object is warm (remaining turns > 0)
   */
  isWarm(objectId: string): boolean {
    return (this.warmObjects.get(objectId) ?? 0) > 0;
  }

  /**
   * Check if a tool call result is currently warm.
   *
   * Returns true if the tool call has been marked warm and has not yet cooled.
   * Used by externalization algorithm to skip warm tool results.
   *
   * @param toolCallId - The tool call ID
   * @returns true if the tool call result is warm (remaining turns > 0)
   */
  isToolCallWarm(toolCallId: string): boolean {
    return (this.warmToolCalls.get(toolCallId) ?? 0) > 0;
  }

  /**
   * Decrement all warm counters by 1.
   *
   * Called once per turn in the context handler (§4.2, step 2).
   * Entries expire (removed from map) when counter reaches 0.
   *
   * This ensures objects stay warm for exactly warmTurns turns after being marked.
   */
  tick(): void {
    // Decrement warmObjects counters
    for (const [k, v] of this.warmObjects) {
      if (v <= 1) {
        this.warmObjects.delete(k);
      } else {
        this.warmObjects.set(k, v - 1);
      }
    }

    // Decrement warmToolCalls counters
    for (const [k, v] of this.warmToolCalls) {
      if (v <= 1) {
        this.warmToolCalls.delete(k);
      } else {
        this.warmToolCalls.set(k, v - 1);
      }
    }
  }

  /**
   * Get the number of currently warm objects.
   * For debugging and monitoring.
   */
  getWarmObjectCount(): number {
    return this.warmObjects.size;
  }

  /**
   * Get the number of currently warm tool calls.
   * For debugging and monitoring.
   */
  getWarmToolCallCount(): number {
    return this.warmToolCalls.size;
  }

  /**
   * Clear all warm entries.
   * Useful for testing and resets.
   */
  clear(): void {
    this.warmObjects.clear();
    this.warmToolCalls.clear();
  }
}
