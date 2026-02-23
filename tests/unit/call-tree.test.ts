/**
 * Unit tests for CallTree per §14.4 of the design spec.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { CallTree, CallNode } from "../../src/engine/call-tree.js";

describe("CallTree", () => {
  let callTree: CallTree;

  beforeEach(() => {
    callTree = new CallTree(10); // 10 max child calls
  });

  describe("registerOperation", () => {
    it("should register an operation and return an AbortController", () => {
      const controller = callTree.registerOperation("op-1", 0.01);
      expect(controller).toBeInstanceOf(AbortController);
    });

    it("should create operation entry with correct initial values", () => {
      const operationId = "op-1";
      const estimatedCost = 0.05;
      callTree.registerOperation(operationId, estimatedCost);

      expect(callTree.getOperationEstimate(operationId)).toBe(estimatedCost);
      expect(callTree.getOperationActual(operationId)).toBe(0);
    });
  });

  describe("incrementChildCalls", () => {
    it("should increment child call counter and return true when under budget", () => {
      const opId = "op-1";
      callTree.registerOperation(opId, 0.01);

      for (let i = 0; i < 10; i++) {
        expect(callTree.incrementChildCalls(opId)).toBe(true);
      }
    });

    it("should return false when budget is exceeded", () => {
      const opId = "op-1";
      callTree.registerOperation(opId, 0.01);

      // Increment 10 times (max is 10)
      for (let i = 0; i < 10; i++) {
        callTree.incrementChildCalls(opId);
      }

      // 11th call should exceed budget
      expect(callTree.incrementChildCalls(opId)).toBe(false);
    });

    it("should return false for non-existent operation", () => {
      expect(callTree.incrementChildCalls("non-existent")).toBe(false);
    });
  });

  describe("completeOperation", () => {
    it("should remove operation from tracking", () => {
      const opId = "op-1";
      callTree.registerOperation(opId, 0.01);
      callTree.completeOperation(opId);

      // Should return false after completion
      expect(callTree.incrementChildCalls(opId)).toBe(false);
    });
  });

  describe("registerCall", () => {
    it("should register a call node", () => {
      const opId = "op-1";
      callTree.registerOperation(opId, 0.01);

      const node = {
        callId: "call-1",
        parentCallId: null,
        operationId: opId,
        depth: 0,
        model: "gpt-4",
        query: "test query",
        status: "running" as const,
        startTime: Date.now(),
        tokensIn: 100,
        tokensOut: 50,
      };

      callTree.registerCall(node);
      const active = callTree.getActive();
      expect(active.length).toBe(1);
      expect(active[0].callId).toBe("call-1");
    });

    it("should build parent-child relationships", () => {
      const opId = "op-1";
      callTree.registerOperation(opId, 0.01);

      const parent = {
        callId: "call-1",
        parentCallId: null,
        operationId: opId,
        depth: 0,
        model: "gpt-4",
        query: "test",
        status: "running" as const,
        startTime: Date.now(),
        tokensIn: 100,
        tokensOut: 50,
      };

      const child = {
        callId: "call-2",
        parentCallId: "call-1",
        operationId: opId,
        depth: 1,
        model: "gpt-4",
        query: "test",
        status: "running" as const,
        startTime: Date.now(),
        tokensIn: 50,
        tokensOut: 25,
      };

      callTree.registerCall(parent);
      callTree.registerCall(child);

      const tree = callTree.getTree();
      expect(tree.length).toBe(1);
      expect(tree[0].children.length).toBe(1);
      expect(tree[0].children[0].callId).toBe("call-2");
    });
  });

  describe("updateCall", () => {
    it("should update call node status", () => {
      const opId = "op-1";
      callTree.registerOperation(opId, 0.01);

      callTree.registerCall({
        callId: "call-1",
        parentCallId: null,
        operationId: opId,
        depth: 0,
        model: "gpt-4",
        query: "test",
        status: "running",
        startTime: Date.now(),
        tokensIn: 100,
        tokensOut: 50,
      });

      callTree.updateCall("call-1", { status: "success", wallClockMs: 1000 });

      const active = callTree.getActive();
      expect(active.length).toBe(0); // No longer running
    });
  });

  describe("abortOperation", () => {
    it("should abort a single operation", () => {
      const controller = callTree.registerOperation("op-1", 0.01);
      const onAbort = vi.fn();

      controller.signal.addEventListener("abort", onAbort);

      callTree.abortOperation("op-1");
      expect(controller.signal.aborted).toBe(true);
      expect(onAbort).toHaveBeenCalledTimes(1);
    });
  });

  describe("abortAll", () => {
    it("should abort all active operations", () => {
      const c1 = callTree.registerOperation("op-1", 0.01);
      const c2 = callTree.registerOperation("op-2", 0.01);
      const c3 = callTree.registerOperation("op-3", 0.01);

      callTree.abortAll();

      expect(c1.signal.aborted).toBe(true);
      expect(c2.signal.aborted).toBe(true);
      expect(c3.signal.aborted).toBe(true);
    });
  });

  describe("getActive", () => {
    it("should return only running calls", () => {
      const opId = "op-1";
      callTree.registerOperation(opId, 0.01);

      callTree.registerCall({
        callId: "call-1",
        parentCallId: null,
        operationId: opId,
        depth: 0,
        model: "gpt-4",
        query: "test",
        status: "running",
        startTime: Date.now(),
        tokensIn: 100,
        tokensOut: 50,
      });

      callTree.registerCall({
        callId: "call-2",
        parentCallId: null,
        operationId: opId,
        depth: 0,
        model: "gpt-4",
        query: "test",
        status: "success",
        startTime: Date.now(),
        tokensIn: 100,
        tokensOut: 50,
      });

      const active = callTree.getActive();
      expect(active.length).toBe(1);
      expect(active[0].callId).toBe("call-1");
    });
  });

  describe("maxActiveDepth", () => {
    it("should return maximum depth of running calls", () => {
      const opId = "op-1";
      callTree.registerOperation(opId, 0.01);

      callTree.registerCall({
        callId: "call-1",
        parentCallId: null,
        operationId: opId,
        depth: 0,
        model: "gpt-4",
        query: "test",
        status: "running",
        startTime: Date.now(),
        tokensIn: 100,
        tokensOut: 50,
      });

      callTree.registerCall({
        callId: "call-2",
        parentCallId: "call-1",
        operationId: opId,
        depth: 1,
        model: "gpt-4",
        query: "test",
        status: "running",
        startTime: Date.now(),
        tokensIn: 50,
        tokensOut: 25,
      });

      callTree.registerCall({
        callId: "call-3",
        parentCallId: "call-2",
        operationId: opId,
        depth: 2,
        model: "gpt-4",
        query: "test",
        status: "running",
        startTime: Date.now(),
        tokensIn: 25,
        tokensOut: 12,
      });

      expect(callTree.maxActiveDepth()).toBe(2);
    });
  });

  describe("addActualCost", () => {
    it("should accumulate actual cost for an operation", () => {
      const opId = "op-1";
      callTree.registerOperation(opId, 0.05);

      callTree.addActualCost(opId, 0.01);
      expect(callTree.getOperationActual(opId)).toBe(0.01);

      callTree.addActualCost(opId, 0.02);
      expect(callTree.getOperationActual(opId)).toBe(0.03);
    });
  });

  describe("getActiveOperation", () => {
    it("should return the most recent active operation", () => {
      const c1 = callTree.registerOperation("op-1", 0.01);
      const c2 = callTree.registerOperation("op-2", 0.02);

      const activeOp = callTree.getActiveOperation();
      expect(activeOp).toBeDefined();
      expect(activeOp?.operationId).toBe("op-2"); // Most recent
    });

    it("should return undefined if no operations are registered", () => {
      expect(callTree.getActiveOperation()).toBeUndefined();
    });
  });
});
