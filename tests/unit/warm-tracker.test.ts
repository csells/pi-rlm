/**
 * Unit tests for WarmTracker.
 * Per §14 (Testing Strategy) and §5.2.2 of the design spec.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { WarmTracker } from "../../src/context/warm-tracker.js";

describe("WarmTracker", () => {
  let tracker: WarmTracker;

  beforeEach(() => {
    tracker = new WarmTracker(3); // Default 3 turns
  });

  describe("markWarm", () => {
    it("should mark objects as warm", () => {
      tracker.markWarm(["obj_1", "obj_2"]);
      expect(tracker.isWarm("obj_1")).toBe(true);
      expect(tracker.isWarm("obj_2")).toBe(true);
    });

    it("should handle empty array", () => {
      tracker.markWarm([]);
      expect(tracker.getWarmObjectCount()).toBe(0);
    });

    it("should reset warm counter for already-warm objects", () => {
      tracker.markWarm(["obj_1"]);
      tracker.tick(); // 2 turns remaining
      tracker.markWarm(["obj_1"]); // Reset to 3
      tracker.tick();
      tracker.tick(); // 1 turn remaining
      expect(tracker.isWarm("obj_1")).toBe(true);
    });

    it("should support multiple markings", () => {
      tracker.markWarm(["obj_1"]);
      tracker.markWarm(["obj_2", "obj_3"]);
      expect(tracker.getWarmObjectCount()).toBe(3);
    });
  });

  describe("markToolCallWarm", () => {
    it("should mark tool calls as warm", () => {
      tracker.markToolCallWarm("call_1");
      tracker.markToolCallWarm("call_2");
      expect(tracker.isToolCallWarm("call_1")).toBe(true);
      expect(tracker.isToolCallWarm("call_2")).toBe(true);
    });

    it("should track tool calls separately from objects", () => {
      tracker.markWarm(["obj_1"]);
      tracker.markToolCallWarm("call_1");
      expect(tracker.getWarmObjectCount()).toBe(1);
      expect(tracker.getWarmToolCallCount()).toBe(1);
    });

    it("should reset warm counter for already-warm tool calls", () => {
      tracker.markToolCallWarm("call_1");
      tracker.tick();
      tracker.tick();
      tracker.markToolCallWarm("call_1"); // Reset to 3
      tracker.tick();
      expect(tracker.isToolCallWarm("call_1")).toBe(true);
    });
  });

  describe("isWarm", () => {
    it("should return false for unmarked objects", () => {
      expect(tracker.isWarm("obj_unknown")).toBe(false);
    });

    it("should return true for warm objects", () => {
      tracker.markWarm(["obj_1"]);
      expect(tracker.isWarm("obj_1")).toBe(true);
    });

    it("should return false after cooling", () => {
      tracker.markWarm(["obj_1"]);
      tracker.tick();
      tracker.tick();
      tracker.tick(); // 3 ticks, counter reaches 0
      expect(tracker.isWarm("obj_1")).toBe(false);
    });
  });

  describe("isToolCallWarm", () => {
    it("should return false for unmarked tool calls", () => {
      expect(tracker.isToolCallWarm("call_unknown")).toBe(false);
    });

    it("should return true for warm tool calls", () => {
      tracker.markToolCallWarm("call_1");
      expect(tracker.isToolCallWarm("call_1")).toBe(true);
    });

    it("should return false after cooling", () => {
      tracker.markToolCallWarm("call_1");
      tracker.tick();
      tracker.tick();
      tracker.tick(); // 3 ticks, counter reaches 0
      expect(tracker.isToolCallWarm("call_1")).toBe(false);
    });
  });

  describe("tick", () => {
    it("should decrement warm counters", () => {
      tracker.markWarm(["obj_1"]);
      expect(tracker.isWarm("obj_1")).toBe(true);
      tracker.tick();
      expect(tracker.isWarm("obj_1")).toBe(true); // Still warm (2 remaining)
      tracker.tick();
      expect(tracker.isWarm("obj_1")).toBe(true); // Still warm (1 remaining)
      tracker.tick();
      expect(tracker.isWarm("obj_1")).toBe(false); // Cooled
    });

    it("should decrement tool call counters independently", () => {
      tracker.markWarm(["obj_1"]);
      tracker.markToolCallWarm("call_1");
      tracker.tick();
      tracker.tick();
      expect(tracker.isWarm("obj_1")).toBe(true); // Still warm (1 remaining)
      expect(tracker.isToolCallWarm("call_1")).toBe(true); // Still warm (1 remaining)
      tracker.tick();
      expect(tracker.isWarm("obj_1")).toBe(false); // Cooled
      expect(tracker.isToolCallWarm("call_1")).toBe(false); // Cooled
    });

    it("should handle multiple objects cooling at different times", () => {
      tracker.markWarm(["obj_1", "obj_2"]);
      tracker.tick(); // obj_1/obj_2: 2 remaining
      tracker.markWarm(["obj_3"]); // obj_3: 3 remaining
      tracker.tick(); // obj_1/obj_2: 1 remaining, obj_3: 2 remaining

      expect(tracker.isWarm("obj_1")).toBe(true);
      expect(tracker.isWarm("obj_2")).toBe(true);
      expect(tracker.isWarm("obj_3")).toBe(true);

      tracker.tick(); // obj_1/obj_2 cool, obj_3: 1 remaining
      expect(tracker.isWarm("obj_1")).toBe(false);
      expect(tracker.isWarm("obj_2")).toBe(false);
      expect(tracker.isWarm("obj_3")).toBe(true);
    });

    it("should clean up expired entries from map", () => {
      tracker.markWarm(["obj_1", "obj_2"]);
      tracker.tick();
      tracker.tick();
      tracker.tick();
      expect(tracker.getWarmObjectCount()).toBe(0);
    });

    it("should handle empty warm maps", () => {
      expect(() => tracker.tick()).not.toThrow();
      expect(tracker.getWarmObjectCount()).toBe(0);
    });
  });

  describe("Custom warmTurns", () => {
    it("should respect custom warmTurns count", () => {
      const shortTracker = new WarmTracker(1);
      shortTracker.markWarm(["obj_1"]);
      expect(shortTracker.isWarm("obj_1")).toBe(true);
      shortTracker.tick();
      expect(shortTracker.isWarm("obj_1")).toBe(false); // Cooled after 1 tick
    });

    it("should handle long warmTurns", () => {
      const longTracker = new WarmTracker(5);
      longTracker.markWarm(["obj_1"]);
      for (let i = 0; i < 4; i++) {
        longTracker.tick();
        expect(longTracker.isWarm("obj_1")).toBe(true);
      }
      longTracker.tick();
      expect(longTracker.isWarm("obj_1")).toBe(false);
    });
  });

  describe("clear", () => {
    it("should clear all warm entries", () => {
      tracker.markWarm(["obj_1", "obj_2"]);
      tracker.markToolCallWarm("call_1");
      expect(tracker.getWarmObjectCount()).toBe(2);
      expect(tracker.getWarmToolCallCount()).toBe(1);
      tracker.clear();
      expect(tracker.getWarmObjectCount()).toBe(0);
      expect(tracker.getWarmToolCallCount()).toBe(0);
      expect(tracker.isWarm("obj_1")).toBe(false);
      expect(tracker.isToolCallWarm("call_1")).toBe(false);
    });
  });

  describe("Integration: prevent thrashing scenario", () => {
    it("should prevent retrieve→externalize→retrieve cycle", () => {
      // Scenario: rlm_peek retrieves obj_1, then externalization tries to externalize it

      // 1. rlm_peek retrieves obj_1 and marks it warm
      tracker.markWarm(["obj_1"]);
      tracker.markToolCallWarm("peek_call_1");

      // 2. Externalization checks: should skip obj_1 (warm)
      expect(tracker.isWarm("obj_1")).toBe(true);
      expect(tracker.isToolCallWarm("peek_call_1")).toBe(true);

      // 3. Next turn: tick and check again
      tracker.tick();
      expect(tracker.isWarm("obj_1")).toBe(true); // Still warm
      expect(tracker.isToolCallWarm("peek_call_1")).toBe(true); // Still warm

      // 4. After warmTurns ticks: object cools and can be externalized
      tracker.tick();
      tracker.tick();
      expect(tracker.isWarm("obj_1")).toBe(false); // Can now externalize
      expect(tracker.isToolCallWarm("peek_call_1")).toBe(false);
    });

    it("should support rapid repeated retrieval", () => {
      // Scenario: multiple rlm_peek calls on same object

      // First retrieval
      tracker.markWarm(["obj_1"]);
      expect(tracker.isWarm("obj_1")).toBe(true);

      // Second retrieval (re-marks as warm)
      tracker.markWarm(["obj_1"]); // Reset counter to 3
      tracker.tick();
      expect(tracker.isWarm("obj_1")).toBe(true);

      // Third retrieval (re-marks as warm)
      tracker.markWarm(["obj_1"]); // Reset counter to 3
      tracker.tick();
      tracker.tick();
      expect(tracker.isWarm("obj_1")).toBe(true);

      // Eventually cools after inactivity
      tracker.tick();
      expect(tracker.isWarm("obj_1")).toBe(false);
    });
  });
});
