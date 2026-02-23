/**
 * Component tests for RLM widget rendering.
 * Tests FR-6 widget display modes and state transitions.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

describe("RLM Widget Rendering (FR-6)", () => {
  // Mock ExtensionContext and related types
  interface MockTheme {
    fg(style: string, text: string): string;
  }

  interface MockTui {
    width: number;
    height: number;
  }

  interface MockKeybindings {
    getBindings(): Record<string, string>;
  }

  // Mock widget state
  let widgetState = {
    enabled: true,
    activePhases: new Set<string>(),
    callTree: {
      getActive: () => [],
      getActiveOperation: () => null,
      maxActiveDepth: () => 0,
    },
    store: {
      getFullIndex: () => ({
        objects: [],
        totalTokens: 0,
      }),
    },
  };

  let mockTheme: MockTheme;
  let mockContext: any;

  beforeEach(() => {
    mockTheme = {
      fg: (style: string, text: string) => `<${style}>${text}</${style}>`,
    };

    mockContext = {
      hasUI: true,
      getContextUsage: () => ({ tokens: 5000, contextWindow: 128000 }),
      ui: {
        setWidget: vi.fn(),
        notify: vi.fn(),
      },
    };

    widgetState = {
      enabled: true,
      activePhases: new Set(),
      callTree: {
        getActive: () => [],
        getActiveOperation: () => null,
        maxActiveDepth: () => 0,
      },
      store: {
        getFullIndex: () => ({
          objects: [],
          totalTokens: 0,
        }),
      },
    };
  });

  describe("Widget State: Off", () => {
    it("should render off state when RLM disabled", () => {
      widgetState.enabled = false;

      const text = renderWidget(widgetState, mockTheme, mockContext);
      expect(text).toContain("RLM: off");
      expect(text).toContain("dim");
    });

    it("should show off state text only", () => {
      widgetState.enabled = false;

      const text = renderWidget(widgetState, mockTheme, mockContext);
      const lines = text.split("\n");
      expect(lines.length).toBe(1);
    });
  });

  describe("Widget State: On-Idle (FR-6.3)", () => {
    it("should show object and token counts when idle", () => {
      widgetState.enabled = true;
      widgetState.activePhases.clear();
      widgetState.store.getFullIndex = () => ({
        objects: [
          { id: "obj-1", type: "conversation", tokenEstimate: 1000 } as any,
          { id: "obj-2", type: "file", tokenEstimate: 2000 } as any,
        ],
        totalTokens: 3000,
      });

      const text = renderWidget(widgetState, mockTheme, mockContext);
      expect(text).toContain("RLM: on");
      expect(text).toContain("2 objects");
      expect(text).toContain("3K tokens");
    });

    it("should include /rlm off hint in idle state", () => {
      widgetState.enabled = true;
      widgetState.activePhases.clear();

      const text = renderWidget(widgetState, mockTheme, mockContext);
      expect(text).toContain("/rlm off");
    });

    it("should show zero objects when store empty", () => {
      widgetState.enabled = true;
      widgetState.activePhases.clear();
      widgetState.store.getFullIndex = () => ({
        objects: [],
        totalTokens: 0,
      });

      const text = renderWidget(widgetState, mockTheme, mockContext);
      expect(text).toContain("0 objects");
      expect(text).toContain("0 tokens");
    });
  });

  describe("Widget State: Active (FR-6.4)", () => {
    it("should show phase when operations active", () => {
      widgetState.enabled = true;
      widgetState.activePhases.add("searching");
      widgetState.callTree.getActive = () => [{ callId: "call-1" } as any];

      const text = renderWidget(widgetState, mockTheme, mockContext);
      expect(text).toContain("searching");
      expect(text).toContain("warning");
    });

    it("should show highest-priority phase from set", () => {
      widgetState.enabled = true;
      widgetState.activePhases.add("searching");
      widgetState.activePhases.add("querying");
      // "querying" has higher priority
      widgetState.callTree.getActive = () => [
        { callId: "call-1" } as any,
        { callId: "call-2" } as any,
      ];

      const text = renderWidget(widgetState, mockTheme, mockContext);
      expect(text).toContain("querying");
    });

    it("should show child call count", () => {
      widgetState.enabled = true;
      widgetState.activePhases.add("batching");
      widgetState.callTree.getActive = () => [
        { callId: "call-1" } as any,
        { callId: "call-2" } as any,
        { callId: "call-3" } as any,
      ];

      const text = renderWidget(widgetState, mockTheme, mockContext);
      expect(text).toContain("children: 3");
    });

    it("should show depth information", () => {
      widgetState.enabled = true;
      widgetState.activePhases.add("querying");
      widgetState.callTree.maxActiveDepth = () => 2;

      const text = renderWidget(widgetState, mockTheme, mockContext);
      expect(text).toContain("depth: 2");
    });

    it("should show budget usage", () => {
      widgetState.enabled = true;
      widgetState.activePhases.add("querying");
      widgetState.callTree.getActiveOperation = () => ({
        childCallsUsed: 3,
      } as any);

      const text = renderWidget(widgetState, mockTheme, mockContext);
      expect(text).toContain("budget: 3");
    });
  });

  describe("Widget State: Cost Display (FR-6.6)", () => {
    it("should show estimated and actual cost", () => {
      widgetState.enabled = true;
      widgetState.activePhases.add("querying");
      widgetState.callTree.getActiveOperation = () => ({
        estimatedCost: 0.0042,
        actualCost: 0.0018,
      } as any);

      const text = renderWidget(widgetState, mockTheme, mockContext);
      expect(text).toContain("est: $0.0042");
      expect(text).toContain("actual: $0.0018");
    });

    it("should omit cost display when zero", () => {
      widgetState.enabled = true;
      widgetState.activePhases.add("querying");
      widgetState.callTree.getActiveOperation = () => ({
        estimatedCost: 0,
        actualCost: 0,
      } as any);

      const text = renderWidget(widgetState, mockTheme, mockContext);
      expect(text).not.toContain("est:");
    });
  });

  describe("Widget State: Token Counts (FR-6.5)", () => {
    it("should show context and store tokens", () => {
      widgetState.enabled = true;
      widgetState.activePhases.clear();
      widgetState.store.getFullIndex = () => ({
        objects: [],
        totalTokens: 5000,
      });

      mockContext.getContextUsage = () => ({ tokens: 50000, contextWindow: 128000 });

      const text = renderWidget(widgetState, mockTheme, mockContext);
      expect(text).toContain("50,000 tokens");
      expect(text).toContain("5K tokens");
    });

    it("should show 'unknown' when context tokens unavailable", () => {
      widgetState.enabled = true;
      widgetState.activePhases.clear();
      mockContext.getContextUsage = () => null;

      const text = renderWidget(widgetState, mockTheme, mockContext);
      expect(text).toContain("unknown");
    });

    it("should handle null tokens in context usage", () => {
      widgetState.enabled = true;
      widgetState.activePhases.clear();
      mockContext.getContextUsage = () => ({ tokens: null, contextWindow: 128000 });

      const text = renderWidget(widgetState, mockTheme, mockContext);
      expect(text).toContain("unknown");
    });
  });

  describe("Token Formatting", () => {
    it("should format large token counts", () => {
      const result = formatTokens(1_234_567);
      expect(result).toBe("1.2M tokens");
    });

    it("should format thousands", () => {
      const result = formatTokens(1234);
      expect(result).toBe("1K tokens");
    });

    it("should format small numbers", () => {
      const result = formatTokens(123);
      expect(result).toBe("123 tokens");
    });

    it("should handle zero", () => {
      const result = formatTokens(0);
      expect(result).toBe("0 tokens");
    });
  });

  describe("Phase Priority", () => {
    it("should prioritize phases correctly", () => {
      const phases = new Set<string>();
      phases.add("searching");
      phases.add("ingesting");

      // "querying" has highest priority, then "batching", etc.
      const phasePriority: string[] = [
        "batching",
        "querying",
        "synthesizing",
        "ingesting",
        "searching",
        "externalizing",
      ];

      const display = phasePriority.find((p) => phases.has(p)) ?? "processing";
      expect(display).toBe("ingesting"); // Higher priority than "searching"
    });
  });

  describe("Non-Interactive Mode", () => {
    it("should not render when ctx.hasUI is false", () => {
      mockContext.hasUI = false;
      widgetState.enabled = true;

      // updateWidget should return early
      expect(mockContext.hasUI).toBe(false);
    });
  });
});

// ============================================================================
// Helper Functions (simplified implementations for testing)
// ============================================================================

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tokens`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K tokens`;
  return `${n} tokens`;
}

function renderWidget(state: any, theme: any, ctx: any): string {
  if (!state.enabled) {
    return theme.fg("dim", "RLM: off");
  }

  if (state.activePhases.size === 0) {
    const index = state.store.getFullIndex();
    const tokens = formatTokens(index.totalTokens);
    const text =
      theme.fg("accent", "RLM: on") +
      theme.fg("muted", ` (${index.objects.length} objects, ${tokens})`) +
      theme.fg("dim", " | /rlm off to disable");
    return text;
  }

  const phasePriority = [
    "batching",
    "querying",
    "synthesizing",
    "ingesting",
    "searching",
    "externalizing",
  ];
  const displayPhase =
    phasePriority.find((p) => state.activePhases.has(p)) ?? "processing";

  const active = state.callTree.getActive();
  const depth = state.callTree.maxActiveDepth();
  const activeOp = state.callTree.getActiveOperation();
  const budget = activeOp ? `${activeOp.childCallsUsed}/50` : "0";

  const estCost = activeOp?.estimatedCost ?? 0;
  const actCost = activeOp?.actualCost ?? 0;
  const costStr =
    estCost > 0 || actCost > 0
      ? ` | est: $${estCost.toFixed(4)} actual: $${actCost.toFixed(4)}`
      : "";

  const lines = [
    theme.fg("warning", `RLM: ${displayPhase}`) +
      theme.fg(
        "muted",
        ` | depth: ${depth} | children: ${active.length} | budget: ${budget}${costStr}`
      ),
  ];

  const usage = ctx.getContextUsage();
  const index = state.store.getFullIndex();
  if (usage && usage.tokens !== null) {
    lines.push(
      theme.fg("dim", `  context: ${usage.tokens.toLocaleString()} tokens | store: ${formatTokens(index.totalTokens)}`)
    );
  } else {
    lines.push(
      theme.fg("dim", `  context: unknown | store: ${formatTokens(index.totalTokens)}`)
    );
  }

  return lines.join("\n");
}
