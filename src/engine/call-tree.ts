/**
 * CallTree: Tracks active operations with AbortControllers for cancellation
 * and observability. Per §2.3 of the design.
 */

export interface CallNode {
  callId: string;
  parentCallId: string | null;
  operationId: string;
  depth: number;
  model: string;
  query: string; // Instructions, truncated for display
  status: "running" | "success" | "error" | "timeout" | "cancelled";
  startTime: number;
  wallClockMs?: number;
  tokensIn: number;
  tokensOut: number;
  children: CallNode[];
}

export interface OperationEntry {
  operationId: string;
  controller: AbortController;
  rootCallId: string | null;
  childCallsUsed: number;
  estimatedCost: number;
  actualCost: number;
  startTime: number;
}

export class CallTree {
  private operations = new Map<string, OperationEntry>();
  private calls = new Map<string, CallNode>();
  private roots: CallNode[] = [];
  private maxChildCalls: number;

  constructor(maxChildCalls: number = 50) {
    this.maxChildCalls = maxChildCalls;
  }

  /**
   * Register a new operation. Returns its AbortController.
   */
  registerOperation(operationId: string, estimatedCost: number): AbortController {
    const controller = new AbortController();
    this.operations.set(operationId, {
      operationId,
      controller,
      rootCallId: null,
      childCallsUsed: 0,
      estimatedCost,
      actualCost: 0,
      startTime: Date.now(),
    });
    return controller;
  }

  /**
   * Increment per-operation child call counter. Returns false if budget exceeded.
   */
  incrementChildCalls(operationId: string): boolean {
    const op = this.operations.get(operationId);
    if (!op) return false;
    op.childCallsUsed++;
    return op.childCallsUsed <= this.maxChildCalls;
  }

  /**
   * Complete/remove an operation.
   */
  completeOperation(operationId: string): void {
    this.operations.delete(operationId);
  }

  /**
   * Register a call node.
   */
  registerCall(node: Omit<CallNode, "children" | "wallClockMs">): void {
    const fullNode: CallNode = { ...node, children: [] };
    this.calls.set(node.callId, fullNode);

    if (node.parentCallId === null) {
      this.roots.push(fullNode);
    } else {
      const parent = this.calls.get(node.parentCallId);
      if (parent) {
        parent.children.push(fullNode);
      }
    }
  }

  /**
   * Update a call node.
   */
  updateCall(callId: string, update: Partial<CallNode>): void {
    const node = this.calls.get(callId);
    if (node) {
      Object.assign(node, update);
    }
  }

  /**
   * Abort a single operation by ID.
   */
  abortOperation(operationId: string): void {
    this.operations.get(operationId)?.controller.abort();
  }

  /**
   * Abort ALL active operations.
   */
  abortAll(): void {
    for (const op of this.operations.values()) {
      op.controller.abort();
    }
  }

  /**
   * Get all nodes with status "running".
   */
  getActive(): CallNode[] {
    const active: CallNode[] = [];
    const walk = (node: CallNode) => {
      if (node.status === "running") {
        active.push(node);
      }
      for (const child of node.children) {
        walk(child);
      }
    };
    for (const root of this.roots) {
      walk(root);
    }
    return active;
  }

  /**
   * Get the maximum active depth.
   */
  maxActiveDepth(): number {
    let max = 0;
    const walk = (node: CallNode, depth: number) => {
      if (node.status === "running") {
        max = Math.max(max, depth);
      }
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    };
    for (const root of this.roots) {
      walk(root, 0);
    }
    return max;
  }

  /**
   * Get the call tree.
   */
  getTree(): CallNode[] {
    return this.roots;
  }

  /**
   * Get the estimated cost for an operation.
   */
  getOperationEstimate(operationId: string): number {
    return this.operations.get(operationId)?.estimatedCost ?? 0;
  }

  /**
   * Get the actual cost for an operation.
   */
  getOperationActual(operationId: string): number {
    return this.operations.get(operationId)?.actualCost ?? 0;
  }

  /**
   * Get the most recent active operation.
   */
  getActiveOperation(): OperationEntry | undefined {
    let latest: OperationEntry | undefined;

    for (const op of this.operations.values()) {
      if (!latest || op.startTime >= latest.startTime) {
        latest = op;
      }
    }

    return latest;
  }

  /**
   * Update actual cost for an operation.
   */
  addActualCost(operationId: string, cost: number): void {
    const op = this.operations.get(operationId);
    if (op) op.actualCost += cost;
  }

  /**
   * Set max child calls limit.
   */
  setMaxChildCalls(max: number): void {
    this.maxChildCalls = max;
  }
}
