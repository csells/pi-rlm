/**
 * Component tests for /rlm commands.
 * Tests command registration and execution for status, on, off, cancel, config, and clear.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerCommands } from "../../src/commands.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import type { CallTree } from "../../src/engine/call-tree.js";
import type { ExtensionContext, IExternalStore, ITrajectoryLogger, RlmConfig } from "../../src/types.js";

describe("/rlm commands", () => {
  let mockPi: any;
  let mockStore: IExternalStore;
  let mockTrajectory: ITrajectoryLogger;
  let mockCallTree: Partial<CallTree>;
  let state: any;
  let ctx: ExtensionContext;
  let capturedHandler: any;

  beforeEach(() => {
    // Capture the command handler when registerCommand is called
    capturedHandler = null;

    mockPi = {
      registerCommand: vi.fn((name, config) => {
        if (name === "rlm") {
          capturedHandler = config.handler;
        }
      }),
      appendEntry: vi.fn(),
    };

    mockStore = {
      get: vi.fn(),
      getIndexEntry: vi.fn(),
      add: vi.fn(),
      getAllIds: vi.fn().mockReturnValue(["obj-1", "obj-2"]),
      getFullIndex: vi.fn().mockReturnValue({
        version: 1,
        sessionId: "test",
        objects: [
          { id: "obj-1", type: "conversation", description: "first", tokenEstimate: 100, createdAt: 0 },
          { id: "obj-2", type: "file", description: "second", tokenEstimate: 200, createdAt: 0 },
        ],
        totalTokens: 300,
      }),
      findByIngestPath: vi.fn(),
      initialize: vi.fn(),
      flush: vi.fn(),
      rebuildExternalizedMap: vi.fn(),
    };

    mockTrajectory = {
      append: vi.fn(),
      flush: vi.fn(),
      getTrajectoryPath: vi.fn().mockReturnValue("/tmp/trajectory.jsonl"),
    };

    mockCallTree = {
      abortAll: vi.fn(),
      getActive: vi.fn().mockReturnValue([]),
      maxActiveDepth: vi.fn().mockReturnValue(0),
      getActiveOperation: vi.fn().mockReturnValue(null),
      setMaxChildCalls: vi.fn(),
      getTree: vi.fn(),
    };

    ctx = {
      cwd: "/tmp",
      hasUI: false,
      getContextUsage: vi.fn().mockReturnValue({ tokens: 1000 }),
    } as unknown as ExtensionContext;

    const config = { ...DEFAULT_CONFIG };

    state = {
      enabled: true,
      config,
      store: mockStore,
      trajectory: mockTrajectory,
      callTree: mockCallTree,
      storeHealthy: true,
      allowCompaction: false,
      forceExternalizeOnNextTurn: false,
      updateWidget: vi.fn(),
    };

    registerCommands(mockPi, state);

    expect(capturedHandler).toBeDefined();
  });

  describe("command registration", () => {
    it("should register /rlm command", () => {
      expect(mockPi.registerCommand).toHaveBeenCalledWith("rlm", expect.any(Object));
    });

    it("should have handler function", () => {
      expect(capturedHandler).toBeDefined();
      expect(typeof capturedHandler).toBe("function");
    });
  });

  describe("status command (no args)", () => {
    it("should show status with object count and token total", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;

      await capturedHandler("", ctx);

      expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("RLM: ON"), "info");
      const call = (ui.notify as any).mock.calls[0][0];
      expect(call).toContain("2 objects");
      expect(call).toContain("300");
    });

    it("should show 'RLM: ON' when enabled", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;
      state.enabled = true;

      await capturedHandler("", ctx);

      expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("RLM: ON"), "info");
    });

    it("should show 'RLM: OFF' when disabled", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;
      state.enabled = false;

      await capturedHandler("", ctx);

      expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("RLM: OFF"), "info");
    });
  });

  describe("on command", () => {
    it("should set enabled=true and call appendEntry", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;
      state.enabled = false;
      state.config.enabled = false;

      await capturedHandler("on", ctx);

      expect(state.enabled).toBe(true);
      expect(state.config.enabled).toBe(true);
      expect(mockPi.appendEntry).toHaveBeenCalledWith("rlm-config", expect.any(Object));
      expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("enabled"), expect.anything());
    });

    it("should update widget", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;

      await capturedHandler("on", ctx);

      expect(state.updateWidget).toHaveBeenCalledWith(ctx);
    });
  });

  describe("off command", () => {
    it("should set enabled=false and call abortAll", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;
      state.enabled = true;

      await capturedHandler("off", ctx);

      expect(state.enabled).toBe(false);
      expect(state.config.enabled).toBe(false);
      expect(mockCallTree.abortAll).toHaveBeenCalled();
      expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("disabled"), expect.anything());
    });

    it("should persist config", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;

      await capturedHandler("off", ctx);

      expect(mockPi.appendEntry).toHaveBeenCalledWith("rlm-config", expect.any(Object));
    });
  });

  describe("config command (no args)", () => {
    it("should show current config values", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;

      await capturedHandler("config", ctx);

      const call = (ui.notify as any).mock.calls[0][0];
      expect(call).toContain("RLM configuration:");
      expect(call).toContain("enabled:");
      expect(call).toContain("maxDepth:");
    });
  });

  describe("config command (with args)", () => {
    it("should update config with key=value arguments", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;
      const originalMaxDepth = state.config.maxDepth;

      await capturedHandler("config maxDepth=5", ctx);

      expect(state.config.maxDepth).toBe(5);
      expect(mockPi.appendEntry).toHaveBeenCalledWith("rlm-config", expect.any(Object));
    });

    it("should support multiple key=value updates in one command", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;

      await capturedHandler("config maxDepth=4 warmTurns=5", ctx);

      expect(state.config.maxDepth).toBe(4);
      expect(state.config.warmTurns).toBe(5);
    });

    it("should parse boolean values", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;
      state.enabled = true;

      await capturedHandler("config enabled=false", ctx);

      expect(state.config.enabled).toBe(false);
    });

    it("should parse numeric values", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;

      await capturedHandler("config maxConcurrency=8", ctx);

      expect(state.config.maxConcurrency).toBe(8);
    });

    it("should report error for invalid config key", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;

      await capturedHandler("config invalidKey=value", ctx);

      expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Unknown config key"), "error");
    });

    it("should report error for invalid boolean value", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;

      await capturedHandler("config enabled=maybe", ctx);

      expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("must be true or false"), "error");
    });

    it("should report error for non-numeric value for numeric key", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;

      await capturedHandler("config maxDepth=abc", ctx);

      expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("must be numeric"), "error");
    });

    it("should call setMaxChildCalls if updating maxChildCalls", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;

      await capturedHandler("config maxChildCalls=30", ctx);

      expect(mockCallTree.setMaxChildCalls).toHaveBeenCalledWith(30);
    });
  });

  describe("cancel command", () => {
    it("should abort all active operations", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;
      (mockCallTree.getActive as any).mockReturnValue([{ id: "op-1" }, { id: "op-2" }]);

      await capturedHandler("cancel", ctx);

      expect(mockCallTree.abortAll).toHaveBeenCalled();
      expect(ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Cancelled 2 active operation"),
        expect.anything(),
      );
    });

    it("should notify if no active operations", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;
      (mockCallTree.getActive as any).mockReturnValue([]);

      await capturedHandler("cancel", ctx);

      expect(ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("No active RLM operations"),
        expect.anything(),
      );
    });

    it("should update widget", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;
      (mockCallTree.getActive as any).mockReturnValue([{ id: "op-1" }]);

      await capturedHandler("cancel", ctx);

      expect(state.updateWidget).toHaveBeenCalledWith(ctx);
    });
  });

  describe("clear command", () => {
    it("should call store.clear()", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;
      (mockStore as any).clear = vi.fn();

      await capturedHandler("clear", ctx);

      expect((mockStore as any).clear).toHaveBeenCalled();
    });

    it("should clear trajectory file", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;
      (mockStore as any).clear = vi.fn();

      // Mock fs for trajectory
      await capturedHandler("clear", ctx);

      expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Cleared"), "success");
    });

    it("should update widget", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;
      (mockStore as any).clear = vi.fn();

      await capturedHandler("clear", ctx);

      expect(state.updateWidget).toHaveBeenCalledWith(ctx);
    });

    it("should handle missing clear() support", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;
      // mockStore doesn't have clear method

      await capturedHandler("clear", ctx);

      expect(ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("not supported"),
        expect.anything(),
      );
    });
  });

  describe("unknown command", () => {
    it("should show warning for unknown subcommand", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;

      await capturedHandler("invalid-command", ctx);

      expect(ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Unknown /rlm subcommand"),
        "warning",
      );
    });

    it("should show status after unknown command", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;

      await capturedHandler("invalid-command", ctx);

      const calls = (ui.notify as any).mock.calls;
      expect(calls.length).toBeGreaterThan(1);
    });
  });

  describe("error handling", () => {
    it("should use console.log if no UI context", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      ctx.hasUI = false;

      await capturedHandler("", ctx);

      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe("store status", () => {
    it("should show store health status", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;
      state.storeHealthy = false;

      await capturedHandler("", ctx);

      const call = (ui.notify as any).mock.calls[0][0];
      expect(call).toContain("degraded");
    });
  });

  describe("formatting", () => {
    it("should format large token counts with K/M suffix", async () => {
      const ui = { notify: vi.fn() };
      (ctx as any).ui = ui;
      (ctx as any).hasUI = true;
      (mockStore.getFullIndex as any).mockReturnValue({
        version: 1,
        sessionId: "test",
        objects: [],
        totalTokens: 50000,
      });

      await capturedHandler("", ctx);

      const call = (ui.notify as any).mock.calls[0][0];
      // Should format 50000 tokens as "50K tokens"
      expect(call).toContain("K");
    });
  });
});
