# Pi-RLM: Technical Design

This document specifies the technical architecture for Pi-RLM, translating the
[requirements](requirements.md) into concrete module designs, data schemas,
event flows, and implementation phases. It is the bridge between "what to
build" and "the code."

**Target audience:** The implementer — human or AI — who will write the
TypeScript.

---

## Table of Contents

1. [Project Structure](#1-project-structure)
2. [Component Architecture](#2-component-architecture) — incl. §2.3 CallTree Interface
3. [Data Schemas](#3-data-schemas) — incl. fingerprint-based message identity, expanded trajectory records
4. [Event Handler Flow](#4-event-handler-flow)
5. [Context Externalization Algorithm](#5-context-externalization-algorithm)
6. [Recursive Call Engine](#6-recursive-call-engine)
7. [Tool Implementations](#7-tool-implementations)
8. [Command Implementations](#8-command-implementations) — incl. `/rlm cancel`
9. [System Prompt Template](#9-system-prompt-template)
10. [Widget Rendering](#10-widget-rendering) — dual cost display (estimated + actual)
11. [Configuration and Persistence](#11-configuration-and-persistence) — incl. §11.3 Large Store Performance
12. [Error Handling Strategy](#12-error-handling-strategy)
13. [Implementation Phases](#13-implementation-phases) — with phase sequencing rationale
14. [Testing Strategy](#14-testing-strategy) — unit, component, integration, LLM behavior tests

---

## 1. Project Structure

Pi-RLM is a **directory-style Pi extension** with npm dependencies, installed
at `~/.pi/agent/extensions/pi-rlm/` (global) or `.pi/extensions/pi-rlm/`
(project-local).

```
pi-rlm/
├── package.json              # name: "pi-rlm", pi.extensions: ["./src/index.ts"]
├── tsconfig.json
├── src/
│   ├── index.ts              # Extension entry point (default export)
│   ├── config.ts             # RlmConfig type + defaults + merge logic
│   ├── store/
│   │   ├── store.ts          # ExternalStore class (JSONL + index)
│   │   ├── types.ts          # StoreObject, StoreIndex, ContentType
│   │   └── write-queue.ts    # Serialized async write queue (NFR-3.4)
│   ├── context/
│   │   ├── manifest.ts       # ManifestBuilder — builds manifest from store
│   │   ├── externalizer.ts   # ContextExternalizer — the context event handler
│   │   ├── warm-tracker.ts   # WarmTracker — tracks warm object IDs (FR-3.9)
│   │   └── tokens.ts         # countMessageTokens() — chars/4 estimation
│   ├── engine/
│   │   ├── engine.ts         # RecursiveEngine — spawns/manages child calls
│   │   ├── call-tree.ts      # CallTree + CallNode — tracks active operations
│   │   ├── concurrency.ts    # ConcurrencyLimiter — Promise pool
│   │   └── cost.ts           # CostEstimator — uses model.cost metadata
│   ├── tools/
│   │   ├── peek.ts           # rlm_peek tool
│   │   ├── search.ts         # rlm_search tool (with worker_threads regex timeout)
│   │   ├── search-worker.ts  # Worker thread for regex execution (NFR-3.5)
│   │   ├── query.ts          # rlm_query tool
│   │   ├── batch.ts          # rlm_batch tool
│   │   ├── ingest.ts         # rlm_ingest tool
│   │   ├── stats.ts          # rlm_stats tool
│   │   ├── extract.ts        # rlm_extract tool (MAY)
│   │   └── guard.ts          # disabledGuard() — returns error if RLM off
│   ├── ui/
│   │   ├── widget.ts         # RlmWidget — persistent status widget
│   │   ├── inspector.ts      # InspectorOverlay — call tree visualizer
│   │   └── phases.ts         # Phase enum + labels
│   ├── commands.ts           # Slash command registrations
│   ├── system-prompt.ts      # System prompt injection template
│   ├── trajectory.ts         # TrajectoryLogger — JSONL trajectory writer
│   └── events.ts             # pi.events emission helpers
├── specs/                    # Vision, requirements, design (this file)
└── tests/                    # Unit tests (vitest) — written per phase
    ├── store.test.ts         # Phase 1
    ├── externalizer.test.ts  # Phase 1
    ├── engine.test.ts        # Phase 2
    ├── manifest.test.ts      # Phase 1
    └── warm-tracker.test.ts  # Phase 3
```

**Dependencies** (package.json):
```json
{
  "name": "pi-rlm",
  "version": "0.1.0",
  "pi": { "extensions": ["./src/index.ts"] },
  "dependencies": {}
}
```

No external npm dependencies. The extension uses only:
- `@mariozechner/pi-coding-agent` — extension types, truncation utilities
- `@mariozechner/pi-ai` — `stream()`, `complete()`, `StringEnum`, model types
- `@mariozechner/pi-tui` — `Text`, `Component` for widget rendering
- `@sinclair/typebox` — tool parameter schemas
- `node:fs`, `node:path`, `node:readline` — file I/O
- `node:crypto` — UUID generation for object/call IDs
- `node:worker_threads` — regex execution with timeout (NFR-3.5)

---

## 2. Component Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Pi Extension Host                        │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    index.ts (entry point)                 │   │
│  │                                                          │   │
│  │  activate(pi: ExtensionAPI) {                            │   │
│  │    1. Load config from session entries                    │   │
│  │    2. Initialize ExternalStore                            │   │
│  │    3. Initialize RecursiveEngine + CostEstimator          │   │
│  │    4. Register event handlers                             │   │
│  │    5. Register tools (always — guard checks state)        │   │
│  │    6. Register commands                                   │   │
│  │    7. Set up widget                                       │   │
│  │  }                                                        │   │
│  └────┬──────────┬──────────┬──────────┬──────────┬─────────┘   │
│       │          │          │          │          │              │
│  ┌────▼───┐ ┌───▼────┐ ┌──▼───┐ ┌───▼────┐ ┌───▼────┐        │
│  │External│ │Context │ │Recur-│ │  Tool  │ │   UI   │        │
│  │ Store  │ │Handler │ │ sive │ │ Suite  │ │ Layer  │        │
│  │        │ │        │ │Engine│ │        │ │        │        │
│  │ store/ │ │context/│ │engine│ │ tools/ │ │  ui/   │        │
│  └───┬────┘ └───┬────┘ └──┬───┘ └───┬────┘ └───┬────┘        │
│      │          │         │         │           │              │
│      └──────────┴────┬────┴─────────┘           │              │
│                      │                          │              │
│              ┌───────▼────────┐          ┌──────▼──────┐       │
│              │  Shared State  │          │  Trajectory │       │
│              │  (RlmState)    │◄────────►│   Logger    │       │
│              └────────────────┘          └─────────────┘       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 2.1 Shared State (`RlmState`)

A single mutable state object shared across all components via closure. Not a
global — created in `activate()` and passed by reference.

```typescript
interface RlmState {
  enabled: boolean;               // RLM mode on/off
  config: RlmConfig;              // User-configurable parameters
  store: ExternalStore;           // The external context store
  manifest: ManifestBuilder;      // Builds manifest from store
  warmTracker: WarmTracker;       // Tracks warm object IDs
  engine: RecursiveEngine;        // Recursive call engine
  callTree: CallTree;             // Active operation tracking + abort registry
  costEstimator: CostEstimator;   // Cost estimation from model metadata
  trajectory: TrajectoryLogger;   // JSONL trajectory writer (all operations)
  phase: Phase;                   // Current processing phase
  sessionId: string;              // Current session identifier
  firstRun: boolean;              // First session_start after install
  turnCount: number;              // LLM call counter (for warm tracking)
  allowCompaction: boolean;       // Safety valve flag (set in context, read in compact)
  storeHealthy: boolean;          // Set false on unrecoverable store error
}
```

### 2.2 Component Responsibilities

| Component | Responsibility | FR Coverage |
|-----------|---------------|-------------|
| `ExternalStore` | Persist/retrieve externalized content on disk | FR-1 |
| `ManifestBuilder` | Generate compact manifest for LLM context | FR-2 |
| `ContextExternalizer` | `context` event handler — stub replacement + externalization | FR-3 |
| `WarmTracker` | Track recently retrieved object IDs, prevent re-externalization | FR-3.9 |
| `RecursiveEngine` | Spawn child LLM calls via `stream()`/`complete()` | FR-5 |
| `CallTree` | Track active operations for observability | FR-5.6, FR-10 |
| `ConcurrencyLimiter` | Bound parallel child calls | FR-5.8 |
| `CostEstimator` | Estimate operation cost from model metadata | FR-6.6, NFR-5 |
| `RlmWidget` | Persistent TUI status widget | FR-6 |
| `InspectorOverlay` | Call tree visualization overlay | FR-7 |
| `TrajectoryLogger` | Append-only JSONL log of all recursive calls | FR-10 |
| `WriteQueue` | Serialize concurrent store writes | NFR-3.4 |

### 2.3 CallTree Interface

The `CallTree` is referenced throughout the design but must be formally defined.
It serves two roles: (a) tracking active operations for observability, and
(b) owning `AbortController` references so that `/rlm cancel` and `/rlm off`
can reach in-flight operations (FR-9.1).

```typescript
interface CallNode {
  callId: string;
  parentCallId: string | null;
  operationId: string;            // Root operation this call belongs to
  depth: number;
  model: string;
  query: string;                  // Instructions (truncated for display)
  status: "running" | "success" | "error" | "timeout" | "cancelled";
  startTime: number;
  wallClockMs?: number;
  tokensIn: number;
  tokensOut: number;
  children: CallNode[];
}

interface OperationEntry {
  operationId: string;
  controller: AbortController;    // Owned by CallTree — tools register on creation
  rootCallId: string | null;
  childCallsUsed: number;         // Per-operation budget counter (FR-5.9)
  estimatedCost: number;          // Pre-run estimate for widget (FR-6.6)
  actualCost: number;             // Running actual cost
  startTime: number;
}

class CallTree {
  private operations = new Map<string, OperationEntry>();
  private calls = new Map<string, CallNode>();
  private roots: CallNode[] = [];

  // --- Operation lifecycle ---

  /** Register a new operation. Returns its AbortController for the tool to use. */
  registerOperation(operationId: string, estimatedCost: number): AbortController {
    const controller = new AbortController();
    this.operations.set(operationId, {
      operationId, controller, rootCallId: null,
      childCallsUsed: 0, estimatedCost, actualCost: 0,
      startTime: Date.now(),
    });
    return controller;
  }

  /** Increment per-operation child call counter. Returns false if budget exceeded. */
  incrementChildCalls(operationId: string): boolean {
    const op = this.operations.get(operationId);
    if (!op) return false;
    op.childCallsUsed++;
    return op.childCallsUsed <= this.maxChildCalls;
  }

  /** Complete/remove an operation. */
  completeOperation(operationId: string): void {
    this.operations.delete(operationId);
  }

  // --- Call tracking ---

  registerCall(node: Omit<CallNode, "children" | "wallClockMs">): void { ... }
  updateCall(callId: string, update: Partial<CallNode>): void { ... }

  // --- Cancellation (FR-9.1) ---

  /** Abort a single operation by ID. */
  abortOperation(operationId: string): void {
    this.operations.get(operationId)?.controller.abort();
  }

  /** Abort ALL active operations. Used by /rlm off and /rlm cancel. */
  abortAll(): void {
    for (const op of this.operations.values()) {
      op.controller.abort();
    }
  }

  // --- Observability ---

  getActive(): CallNode[] { ... }  // All nodes with status "running"
  maxActiveDepth(): number { ... }
  getTree(): CallNode[] { return this.roots; }
  getOperationEstimate(operationId: string): number { ... }
  getOperationActual(operationId: string): number { ... }

  // --- Per-operation budget (FR-5.9, FR-9.6) ---
  private maxChildCalls: number;  // Set from config
}
```

**Key design decisions:**

1. **CallTree owns AbortControllers** — Tools create operations via
   `callTree.registerOperation()` and receive back the `AbortController`.
   The tool wires the controller's signal to its child calls. `/rlm cancel`
   and `/rlm off` call `callTree.abortAll()`, which invokes `.abort()` on
   every registered controller, propagating cancellation to all active
   children via the signal chain.

2. **Per-operation budget** — `childCallsUsed` is tracked per-operation (not
   globally), so one `rlm_batch` consuming its budget doesn't prevent a
   subsequent `rlm_query` from running. This matches FR-5.9 ("per-operation
   child call limit").

3. **Dual cost tracking** — Each operation carries both `estimatedCost`
   (set before execution for the widget's pre-run display per FR-6.6) and
   `actualCost` (accumulated during execution for the widget's live display).

---

## 3. Data Schemas

### 3.1 Store Object (on disk — JSONL record)

Each line in `.pi/rlm/<session-id>/store.jsonl` is one `StoreRecord`:

```typescript
interface StoreRecord {
  id: string;                     // e.g., "rlm-obj-a1b2c3d4"
  type: ContentType;              // "conversation" | "tool_output" | "file" | "artifact"
  description: string;            // Human/LLM-readable summary, ≤100 chars
  createdAt: number;              // Unix timestamp (ms)
  tokenEstimate: number;          // Estimated tokens (chars / 4)
  source: StoreObjectSource;      // How this object entered the store
  content: string;                // The raw content
}

type ContentType = "conversation" | "tool_output" | "file" | "artifact";

type StoreObjectSource =
  | { kind: "externalized"; fingerprint: string }     // From context externalization
  | { kind: "ingested"; path: string }                // From rlm_ingest
  | { kind: "child_result"; callId: string };         // From recursive call
```

**Message identity — fingerprint-based (API-verified):** Pi's `AgentMessage`
types (`UserMessage`, `AssistantMessage`, `ToolResultMessage`, and custom
message types) do **not** have an `id` field. Only `SessionEntry` (the
session-level wrapper) has `id`, and the `context` event delivers raw
`AgentMessage[]` without entry wrappers. The design therefore uses a
**content-based fingerprint** to stably identify messages across turns:

```typescript
function messageFingerprint(msg: AgentMessage): string {
  // ToolResultMessage: toolCallId is unique per tool invocation
  if ("toolCallId" in msg && msg.role === "toolResult") {
    return `toolResult:${msg.toolCallId}`;
  }
  // All standard message types have a timestamp (ms precision)
  if ("timestamp" in msg) {
    return `${msg.role}:${msg.timestamp}`;
  }
  // Fallback: content hash (should not occur with current Pi types)
  const content = typeof msg.content === "string"
    ? msg.content.slice(0, 200)
    : JSON.stringify(msg.content).slice(0, 200);
  return `${msg.role}:${simpleHash(content)}`;
}
```

**Why this works:** Every Pi message type includes a `timestamp` field
(millisecond precision, set via `Date.now()` at creation). The combination of
`role + timestamp` is unique within a session because Pi creates messages
sequentially. For `toolResult` messages, `toolCallId` provides an even stronger
unique identifier. The fingerprint is computed identically on every `context`
event call, so it's stable across turns.

**Reconstruction on restart:** `store.rebuildExternalizedMap()` iterates all
`StoreRecord` entries with `source.kind === "externalized"`, and populates
`externalizedMessages` from `source.fingerprint → record.id`. On the next
`context` event, the handler computes fingerprints for the current messages
and looks them up in the map.

**Edge case — compaction removes messages:** If Pi's compaction fires (safety
valve scenario) and removes older messages, fingerprint lookups for those
messages will simply return no match — the messages are gone from the LLM's
context, so there's nothing to stub-replace. The store records remain on disk
for retrieval via RLM tools.

### 3.2 Store Index (in memory + persisted as `index.json`)

```typescript
interface StoreIndex {
  version: 1;
  sessionId: string;
  objects: StoreIndexEntry[];
  totalTokens: number;            // Sum of all tokenEstimate values
}

interface StoreIndexEntry {
  id: string;
  type: ContentType;
  description: string;
  tokenEstimate: number;
  createdAt: number;
  byteOffset: number;             // Offset in store.jsonl for fast seek
  byteLength: number;             // Length in store.jsonl
}
```

### 3.3 Context Manifest (injected into LLM context)

The manifest is a text block injected into the **message array** by the
`context` event handler (not `before_agent_start`). This ensures newly
externalized objects appear in the same turn's manifest. The manifest is
prepended as a **user-role message** at the start of the messages array.

**Why user-role, not system-role:** Pi's `Message` type union (`UserMessage |
AssistantMessage | ToolResultMessage`) does not include a system-role message
variant. The system prompt is injected separately via `Context.systemPrompt`.
Prepending a `UserMessage` with the manifest text is the correct approach and
is consistent with how Pi's own extension examples inject context.

Format:

```
## RLM External Context

You have access to externalized content via RLM tools. The following objects
are in your external store:

| ID | Type | Tokens | Description |
|----|------|--------|-------------|
| rlm-obj-a1b2c3d4 | file | 2,340 | src/auth.ts (full file) |
| rlm-obj-e5f6g7h8 | tool_output | 847 | Stack trace from bash: npm test |
| rlm-obj-i9j0k1l2 | conversation | 1,205 | Discussion about race condition |
+42 older objects (98,450 tokens total)

Total: 45 objects, 102,842 tokens externalized.
Use rlm_search, rlm_peek, or rlm_query to access this content.
```

**Implementation:** `ManifestBuilder.build(budget: number): string`

1. Sort index entries by `createdAt` descending (most recent first).
2. Render rows until estimated tokens exceed `budget - 200` (reserve for
   header/footer).
3. Collapse remaining entries into a "+N older objects" summary line.
4. Return the formatted text block.

Token estimation for manifest text: character count / 4.

### 3.4 Stub Format (in modified message array)

When content is externalized from the LLM's message array, the original
content is replaced with a stub:

```
[RLM externalized: rlm-obj-a1b2c3d4 | file | 2,340 tokens | src/auth.ts (full file)]
Use rlm_peek("rlm-obj-a1b2c3d4") to view, or rlm_search to find specific content.
```

**Implementation detail:** The `context` event handler receives a deep copy of
messages. The handler modifies this copy in place — replacing content blocks
with stubs. The original messages in the session are untouched. The user's TUI
scroll-back always shows the original content.

### 3.5 Child Call Result (structured response from children)

```typescript
interface ChildCallResult {
  answer: string;
  confidence: "high" | "medium" | "low";
  evidence: string[];             // Relevant quotes or references
}

// Validation wrapper — FR-5.12
function parseChildResult(raw: string): ChildCallResult {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.answer === "string" &&
        ["high", "medium", "low"].includes(parsed.confidence) &&
        Array.isArray(parsed.evidence)) {
      return parsed;
    }
  } catch {}
  // Fallback: wrap raw text
  return { answer: raw, confidence: "low", evidence: [] };
}
```

### 3.6 Trajectory Record

Each line in `.pi/rlm/<session-id>/trajectory.jsonl`. The trajectory covers
**all RLM operations** (NFR-4.1), not just recursive calls:

```typescript
// Recursive call record (rlm_query / rlm_batch children)
interface CallTrajectoryRecord {
  kind: "call";
  callId: string;                 // Unique call identifier
  operationId: string;            // Parent operation (rlm_query or rlm_batch invocation)
  parentCallId: string | null;    // null for root-level tool invocations
  depth: number;                  // 0 = root tool call, 1 = first child, etc.
  model: string;                  // "provider/model-id"
  query: string;                  // The instructions given to the child
  targetIds: string[];            // Store object IDs this call operated on
  result: ChildCallResult | null; // null if cancelled/timed out
  tokensIn: number;
  tokensOut: number;
  wallClockMs: number;
  status: "success" | "error" | "cancelled" | "timeout";
  error?: string;                 // Error message if status is "error"
  timestamp: number;              // Unix timestamp (ms)
}

// Non-recursive operation record (externalization, search, ingest, config)
interface OperationTrajectoryRecord {
  kind: "operation";
  operation: "externalize" | "force_externalize" | "search" | "ingest"
           | "peek" | "stats" | "toggle_on" | "toggle_off";
  objectIds?: string[];           // Objects involved (created, searched, retrieved)
  details?: Record<string, unknown>; // Operation-specific data
  wallClockMs: number;
  timestamp: number;
}

type TrajectoryRecord = CallTrajectoryRecord | OperationTrajectoryRecord;
```

**Rationale (NFR-4.1):** The requirements state "All RLM operations must be
logged to the trajectory file." This includes externalization events, search
operations, ingestion, and state toggles — not just recursive calls. The `kind`
discriminator allows tools to filter for the record types they care about.

### 3.7 Configuration

```typescript
interface RlmConfig {
  enabled: boolean;               // Default: true
  maxDepth: number;               // Default: 2
  maxConcurrency: number;         // Default: 4
  tokenBudgetPercent: number;     // Default: 60
  safetyValvePercent: number;     // Default: 90
  manifestBudget: number;         // Default: 2000 (tokens)
  warmTurns: number;              // Default: 3
  childTimeoutSec: number;        // Default: 120
  operationTimeoutSec: number;    // Default: 600
  maxChildCalls: number;          // Default: 50
  childMaxTokens: number;         // Default: 4096
  childModel?: string;            // Optional: "provider/model-id" for children
  retentionDays: number;          // Default: 30
}

const DEFAULT_CONFIG: RlmConfig = {
  enabled: true,
  maxDepth: 2,
  maxConcurrency: 4,
  tokenBudgetPercent: 60,
  safetyValvePercent: 90,
  manifestBudget: 2000,
  warmTurns: 3,
  childTimeoutSec: 120,
  operationTimeoutSec: 600,
  maxChildCalls: 50,
  childMaxTokens: 4096,
  retentionDays: 30,
};
```

---

## 4. Event Handler Flow

### 4.1 Extension Lifecycle

```
pi starts
  │
  └─► Extension loaded (jiti compiles index.ts)
      │
      └─► activate(pi: ExtensionAPI)
          ├── pi.on("session_start", safeHandler("session_start", onSessionStart))
          ├── pi.on("before_agent_start", safeHandler("before_agent_start", onBeforeAgentStart))
          ├── pi.on("context", safeHandler("context", onContext))
          ├── pi.on("session_before_compact", safeHandler("compact", onBeforeCompact))
          ├── pi.on("session_before_switch", safeHandler("switch", onBeforeSwitch))
          ├── pi.on("session_shutdown", safeHandler("shutdown", onShutdown))
          ├── registerTools(pi, state)    // Always register; tools guard on state.enabled
          ├── registerCommands(pi, state)
          └── setupWidget(pi, state)
```

**Tool availability when disabled (FR-9.2 — deviation from requirements):**
Tools are always registered because Pi's `ExtensionAPI` provides
`registerTool()` but no `unregisterTool()` (verified in Pi's type definitions).
Dynamic deregistration is not possible. Each tool's `execute()` method starts
with `disabledGuard(state)` which returns an error result if `!state.enabled`.
This achieves the intent of FR-8.1 and FR-9.2 ("RLM tools are deregistered")
through the only mechanism available — the tools exist but are inert when
disabled. **FR-8.1 and FR-9.2 in requirements.md should be updated to say
"RLM tools are unavailable" instead of "RLM tools are deregistered."**

```typescript
function disabledGuard(state: RlmState): ToolResult | null {
  if (!state.enabled) {
    return {
      content: [{ type: "text", text: "RLM is disabled. Use /rlm on to enable." }],
      isError: true,
    };
  }
  return null;
}
```

### 4.2 `session_start` Handler

```typescript
async function onSessionStart(_event: any, ctx: ExtensionContext) {
  // 1. Determine session ID
  state.sessionId = ctx.sessionManager.getSessionFile() ?? "ephemeral";

  // 2. Reconstruct config from session entries
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "rlm-config") {
      state.config = { ...DEFAULT_CONFIG, ...entry.data };
    }
  }

  // 3. Initialize/reconstruct store from disk
  const storePath = path.join(ctx.cwd, ".pi", "rlm", state.sessionId);
  state.store = new ExternalStore(storePath);
  await state.store.initialize();  // Reads index.json, or rebuilds from store.jsonl

  // 4. Rebuild externalizedMessages map from store (fingerprint → objectId)
  state.store.rebuildExternalizedMap();  // Scans records with source.kind === "externalized"
  // Populates Map<fingerprint, objectId> — see §3.1 for fingerprint algorithm

  // 5. Initialize trajectory logger
  state.trajectory = new TrajectoryLogger(storePath);

  // 6. First-run notification (FR-14.1) — file-based, not per-session
  const installedFlag = path.join(homedir(), ".pi", "rlm", ".installed");
  if (!existsSync(installedFlag)) {
    if (ctx.hasUI) {
      ctx.ui.notify(
        "Pi-RLM is active. Use /rlm off to disable. Use /rlm for status.",
        "info"
      );
    }
    await fs.promises.mkdir(path.dirname(installedFlag), { recursive: true });
    await fs.promises.writeFile(installedFlag, new Date().toISOString());
  }

  // 7. Cleanup old sessions (FR-1.8) — async, don't block startup
  const rlmDir = path.join(ctx.cwd, ".pi", "rlm");
  cleanupOldSessions(rlmDir, state.config.retentionDays).catch(() => {});

  // 8. Update widget
  updateWidget(ctx);
}
```

### 4.3 `before_agent_start` Handler

Injects the RLM system prompt (tool descriptions, strategies, instructions).
The manifest is injected separately in the `context` handler so it reflects
the current turn's externalization state.

```typescript
async function onBeforeAgentStart(event: any, ctx: ExtensionContext) {
  if (!state.enabled) return;

  const rlmPrompt = buildSystemPrompt(state.config);

  return {
    systemPrompt: event.systemPrompt + "\n\n" + rlmPrompt,
  };
}
```

### 4.4 `context` Event Handler

This is the core externalization handler. Called before every LLM call.

```typescript
async function onContext(event: any, ctx: ExtensionContext) {
  if (!state.enabled) return;

  state.turnCount++;
  state.warmTracker.tick();  // Decrement warm counters

  const messages = event.messages;  // Deep copy — safe to modify

  // Phase 0: ALWAYS replace already-externalized content with stubs (FR-3.3)
  // This must happen regardless of usage checks.
  replaceExternalizedWithStubs(messages, state.store);

  // Phase 1: Check if new externalization is needed
  // Note: ctx.getContextUsage() returns ContextUsage | undefined.
  // ContextUsage.tokens can be null (e.g., right after compaction, before
  // next LLM response). Skip externalization if tokens is unknown.
  const usage = ctx.getContextUsage();
  if (usage && usage.tokens !== null && ctx.model) {
    const model = ctx.model;
    const windowSize = usage.contextWindow;
    const threshold = windowSize * (state.config.tokenBudgetPercent / 100);
    const safetyThreshold = windowSize * (state.config.safetyValvePercent / 100);

    if (usage.tokens > threshold) {
      state.phase = "externalizing";
      updateWidget(ctx);

      // Externalize oldest/largest non-warm content
      // store.add() writes to memory immediately, enqueues disk I/O (NFR-2.1)
      externalize(messages, state, threshold);
    }

    // Phase 2: Safety valve (FR-3.8)
    const postUsage = countMessageTokens(messages);
    if (postUsage > safetyThreshold) {
      forceExternalize(messages, state);

      // If STILL over safety threshold, allow compaction as last resort
      const finalUsage = countMessageTokens(messages);
      if (finalUsage > safetyThreshold) {
        state.allowCompaction = true;
      }
    }
  }

  // Phase 3: Inject manifest into messages (reflects current turn's state)
  if (state.store.getFullIndex().objects.length > 0) {
    const manifest = state.manifest.build(state.config.manifestBudget);
    messages.unshift({
      role: "user",
      content: [{ type: "text", text: manifest }],
      timestamp: 0,  // Synthetic message — timestamp 0 sorts before all real messages
    });
  }

  state.phase = "idle";
  updateWidget(ctx);

  return { messages };
}
```

**Performance (NFR-2.1):** `store.add()` updates the in-memory index
immediately and returns the created object synchronously. The JSONL disk write
is enqueued via `WriteQueue` and completes asynchronously. The context handler
never awaits disk I/O for already-indexed content. Target: <100ms for the
common case (stub replacement + manifest injection, no new externalization).

### 4.5 `session_before_compact` Handler

```typescript
async function onBeforeCompact(event: any, ctx: ExtensionContext) {
  if (!state.enabled) return;

  // Safety valve: if context handler couldn't reduce enough, allow compaction
  if (state.allowCompaction) {
    state.allowCompaction = false;
    return;  // Let Pi compact normally
  }

  // Otherwise, cancel compaction — RLM handles context management
  return { cancel: true };
}
```

### 4.6 `session_before_switch` Handler

```typescript
async function onBeforeSwitch(event: any, ctx: ExtensionContext) {
  // Flush pending writes
  await state.store.flush();
  await state.trajectory.flush();

  // Persist current config and index snapshot
  pi.appendEntry("rlm-config", state.config);
  pi.appendEntry("rlm-index", state.store.getFullIndex());
}
```

---

## 5. Context Externalization Algorithm

### 5.1 Token Estimation for Modified Messages

`ctx.getContextUsage()` reflects the original messages before handler
modification. After modifying messages (replacing content with stubs), the
design needs its own estimation. `countMessageTokens()` provides this:

```typescript
function countMessageTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += Math.ceil(msg.content.length / 4);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          total += Math.ceil(block.text.length / 4);
        }
      }
    }
  }
  return total;
}
```

This is a conservative estimate (4 chars/token). It's used only for
post-modification threshold checks, not for billing.

### 5.2 Normal Externalization (FR-3.2)

Called when context usage exceeds `tokenBudgetPercent`.

```
function externalize(messages, state, threshold):
  candidates = []
  for each message in messages (oldest first):
    if message is most recent user message → skip (FR-3.6)
    if message is most recent assistant message → skip (FR-3.6)

    // Warm check: look up whether this message's objectId is warm
    fp = messageFingerprint(message)
    objectId = externalizedMessages.get(fp)
    if objectId and warmTracker.isWarm(objectId) → skip (FR-3.9)

    if message has tool results with large output → prioritize (FR-3.5)
    candidates.push({ message, fingerprint: fp, estimatedTokens })

  sort candidates by estimatedTokens descending (largest first)

  for each candidate:
    if countMessageTokens(messages) <= threshold → break

    object = store.add({
      type: inferContentType(candidate.message),
      description: generateDescription(candidate.message),
      content: extractContent(candidate.message),
      source: { kind: "externalized", fingerprint: candidate.fingerprint },
    })

    externalizedMessages.set(candidate.fingerprint, object.id)
    replaceWithStub(messages, candidate.message, object)
```

**`store.add()` behavior:** Updates in-memory index synchronously (returns
`StoreRecord` immediately). Enqueues JSONL append + index.json write to
`WriteQueue`. Callers see the object in the index immediately; disk persistence
is eventual but serialized.

### 5.3 Force Externalization (FR-3.8)

Called when context exceeds `safetyValvePercent` after normal externalization.

```
function forceExternalize(messages, state):
  for each message in messages:
    if message is most recent user message → skip
    if message is most recent assistant message → skip
    if message is system prompt → skip

    if not already a stub:
      fp = messageFingerprint(message)
      object = store.add({
        ...,
        source: { kind: "externalized", fingerprint: fp },
      })
      externalizedMessages.set(fp, object.id)
      replaceWithStub(messages, message, object)
```

### 5.4 Stub Replacement for Already-Externalized Content

On subsequent LLM calls, content that was previously externalized will exist
in the session history (because the user's view is unchanged) but should be
stubbed in the LLM's copy.

```typescript
// In-memory tracking — rebuilt from store on session_start (§4.2, step 4)
const externalizedMessages = new Map<string, string>();  // fingerprint → storeObjectId

function replaceExternalizedWithStubs(messages: AgentMessage[], store: ExternalStore) {
  for (const msg of messages) {
    const fp = messageFingerprint(msg);
    const objId = externalizedMessages.get(fp);
    if (objId) {
      const entry = store.getIndexEntry(objId);
      if (entry) {
        replaceContentWithStub(msg, entry);
      }
    }
  }
}
```

**Reconstruction on restart:** `store.rebuildExternalizedMap()` iterates all
`StoreRecord` entries, filters those with `source.kind === "externalized"`, and
populates `externalizedMessages` from `source.fingerprint → record.id`. On the
next `context` event, fingerprints are computed for the current messages and
matched against the map. See §3.1 for the fingerprint algorithm and its
stability guarantees.

### 5.5 Description Generation

For the manifest, each externalized object needs a brief description. This is
generated locally (no LLM call) based on content type:

| Content Type | Description Strategy |
|---|---|
| `file` | Path from tool args, e.g., "src/auth.ts (full file)" |
| `tool_output` | Tool name + first line, e.g., "bash: npm test — 47 lines" |
| `conversation` | Role + first 80 chars, e.g., "User: Can you check the race condition in…" |
| `artifact` | Reserved for `rlm_extract` (MAY). Label from extract instructions, e.g., "Extracted: auth module API surface" |

No LLM calls for descriptions — they're heuristic, fast, and free.

---

## 6. Recursive Call Engine

### 6.1 Architecture

```typescript
class RecursiveEngine {
  constructor(
    private modelRegistry: ModelRegistry,
    private config: RlmConfig,
    private store: ExternalStore,
    private trajectory: TrajectoryLogger,
    private callTree: CallTree,
    private costEstimator: CostEstimator,
  ) {}

  async query(
    instructions: string,
    targetIds: string[],
    parentCallId: string | null,
    depth: number,
    operationId: string,          // For per-operation budget tracking
    operationSignal: AbortSignal,
    ctx: ExtensionContext,
    modelOverride?: string,       // Per-call model override
  ): Promise<ChildCallResult> { ... }

  async batch(
    instructions: string,
    targetIds: string[],
    parentCallId: string | null,
    depth: number,
    operationId: string,          // For per-operation budget tracking
    operationSignal: AbortSignal,
    ctx: ExtensionContext,
    modelOverride?: string,
  ): Promise<ChildCallResult[]> { ... }
}
```

### 6.2 Model Resolution

```typescript
function resolveChildModel(
  modelOverride: string | undefined,
  config: RlmConfig,
  ctx: ExtensionContext,
): Model | null {
  const modelStr = modelOverride ?? config.childModel;
  if (modelStr) {
    const [provider, ...idParts] = modelStr.split("/");
    const id = idParts.join("/");
    const found = ctx.modelRegistry.find(provider, id);
    if (found) return found;
    console.warn(`[pi-rlm] Child model "${modelStr}" not found, falling back to root model`);
  }
  // ctx.model can be undefined (e.g., no model selected yet)
  if (!ctx.model) {
    console.error("[pi-rlm] No model available for child call");
    return null;
  }
  return ctx.model;
}
```

Callers of `resolveChildModel()` **must** check for `null` and return an error
`ChildCallResult` if no model is available:

```typescript
const childModel = resolveChildModel(params.model, state.config, ctx);
if (!childModel) {
  return { content: [{ type: "text", text: "Error: No model available for recursive call. Select a model first." }], isError: true };
}
```

### 6.3 Single Child Call Flow (`query`)

```
RecursiveEngine.query(instructions, targetIds, parentId, depth, operationId, signal, ctx, modelOverride):
  1. Check depth <= config.maxDepth. If exceeded, return error result.
  2. Per-operation budget check:
     if (!callTree.incrementChildCalls(operationId)):
       return { answer: "Budget exceeded", confidence: "low", evidence: [] }
  3. Generate callId = "rlm-call-" + crypto.randomUUID().slice(0,8)
  5. Register call in callTree (id, parentId, depth, status: "running")

  6. Resolve child model via resolveChildModel(modelOverride, config, ctx)

  7. Build child context:
     systemPrompt = buildChildSystemPrompt(instructions, depth, config)
     targetContent = targetIds.map(id => store.get(id).content).join("\n---\n")
     messages: Message[] = [
       { role: "user", content: [{ type: "text", text: targetContent }], timestamp: Date.now() }
     ]

     // If depth < maxDepth, give child access to rlm_peek, rlm_search, rlm_query
     tools = depth < config.maxDepth
       ? [peekToolDef, searchToolDef, queryToolDef]
       : [peekToolDef, searchToolDef]  // No recursion at max depth

  8. Create child abort controller:
     childController = new AbortController()
     childTimeout = setTimeout(() => childController.abort(), config.childTimeoutSec * 1000)
     // Also abort if parent operation is cancelled — use { once: true } to prevent leak
     const onAbort = () => childController.abort()
     signal.addEventListener("abort", onAbort, { once: true })

  9. Execute child call:
     startTime = Date.now()
     try {
       if tools are provided (depth < maxDepth):
         // Run child agent loop (§6.5) — handles tool calls iteratively
         responseText = await runChildAgentLoop(
           model, { systemPrompt, messages, tools }, childController.signal,
           config.childMaxTokens, toolHandlers, /*maxTurns=*/5
         )
         result = parseChildResult(responseText)
       else:
         // No tools — single completion call
         response = await complete(model, { systemPrompt, messages }, {
           signal: childController.signal,
           maxTokens: config.childMaxTokens,
         })
         result = parseChildResult(response.content
           .filter(c => c.type === "text").map(c => c.text).join(""))
       status = "success"
     } catch (err) {
       if (childController.signal.aborted) {
         result = { answer: "Timed out or cancelled", confidence: "low", evidence: [] }
         status = signal.aborted ? "cancelled" : "timeout"
       } else if (isRateLimitError(err)) {
         result = await retryWithBackoff(...)  // FR-5.11
         status = result ? "success" : "error"
       } else {
         result = { answer: err.message, confidence: "low", evidence: [] }
         status = "error"
       }
     } finally {
       clearTimeout(childTimeout)
       signal.removeEventListener("abort", onAbort)
     }

  10. Log to trajectory:
      trajectory.append({
        callId, parentCallId: parentId, depth, model: modelStr,
        query: instructions, targetIds, result,
        tokensIn, tokensOut,
        wallClockMs: Date.now() - startTime,
        status, timestamp: Date.now(),
      })

  11. Update callTree (status: completed/error/timeout)
  12. Mark retrieved content as warm (warmTracker.markWarm(targetIds))
  13. Return result
```

### 6.4 Batch Call Flow (`batch`)

```
RecursiveEngine.batch(instructions, targetIds, parentId, depth, signal, ctx, modelOverride):
  1. Generate operationId = "rlm-batch-" + crypto.randomUUID().slice(0,8)

  2. Register operation in CallTree — get back an AbortController:
     opController = callTree.registerOperation(operationId, estimatedCost)
     opTimeout = setTimeout(() => opController.abort(), config.operationTimeoutSec * 1000)
     // Chain parent signal → operation controller
     const onAbort = () => opController.abort()
     signal.addEventListener("abort", onAbort, { once: true })

  3. Build task list:
     tasks = targetIds.map(id => ({
       targetId: id,
       instructions: instructions,
     }))

  4. Execute with concurrency limiter:
     limiter = new ConcurrencyLimiter(config.maxConcurrency)
     results = await limiter.map(tasks, async (task) => {
       // Per-operation budget check (FR-5.9, FR-9.6)
       if (!callTree.incrementChildCalls(operationId)) {
         opController.abort()  // Cancel remaining children via shared signal
         return { answer: "Budget exceeded", confidence: "low", evidence: [] }
       }
       return await this.query(
         task.instructions, [task.targetId],
         operationId, depth, opController.signal, ctx, modelOverride
       )
     })

  5. clearTimeout(opTimeout)
     signal.removeEventListener("abort", onAbort)
     callTree.completeOperation(operationId)
  6. Return results (including partial results from completed children)
```

**Per-operation budget scoping (FR-5.9):** The child call counter is tracked
per-operation inside `CallTree.OperationEntry.childCallsUsed`, not as a global
counter. Each `rlm_query` or `rlm_batch` invocation starts with a fresh
counter. This means one `rlm_batch(50 targets)` consuming its full budget
does not prevent a subsequent `rlm_query` from running.

### 6.5 Child Agent Loop

When a child call has access to tools (depth < maxDepth), the engine runs a
minimal agent loop:

```typescript
async function runChildAgentLoop(
  model: Model,
  context: Context,
  signal: AbortSignal,
  maxTokens: number,
  toolHandlers: Map<string, ToolHandler>,
  maxTurns: number = 5,  // Prevent infinite loops
): Promise<string> {
  let messages = [...context.messages];
  let turns = 0;

  while (turns < maxTurns) {
    // complete() returns AssistantMessage — content is (TextContent | ThinkingContent | ToolCall)[]
    const response: AssistantMessage = await complete(model, {
      systemPrompt: context.systemPrompt,
      messages,
      tools: context.tools,
    }, { signal, maxTokens });

    // Parse the content array — AssistantMessage has no .text or .toolCalls properties
    const textParts = response.content.filter(c => c.type === "text") as TextContent[];
    const toolCalls = response.content.filter(c => c.type === "toolCall") as ToolCall[];

    // If no tool calls, return the text response
    if (toolCalls.length === 0) {
      return textParts.map(c => c.text).join("");
    }

    // Execute tool calls and append results
    // Push the full AssistantMessage (complete() returns all required fields)
    messages.push(response);
    for (const toolCall of toolCalls) {
      const handler = toolHandlers.get(toolCall.name);
      if (handler) {
        const result = await handler(toolCall.arguments);  // ToolCall.arguments, not .input
        messages.push({
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,           // Required by ToolResultMessage
          content: [{ type: "text", text: result }],
          isError: false,                    // Required by ToolResultMessage
          timestamp: Date.now(),             // Required by ToolResultMessage
        } satisfies ToolResultMessage);
      }
    }
    turns++;
  }

  // Max turns reached — extract text from last assistant message
  const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
  if (lastAssistant) {
    const text = lastAssistant.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("");
    if (text) return text;
  }
  return "Max turns reached";
}
```

**Note on `complete()` return type:** `complete()` returns `AssistantMessage`
whose `content` is `(TextContent | ThinkingContent | ToolCall)[]`. There are
no `.text` or `.toolCalls` convenience properties — you must filter the
content array by `type`. `ToolCall.arguments` (not `.input`) contains the
parsed parameters. `ToolResultMessage` requires `toolName`, `isError`, and
`timestamp` fields in addition to `toolCallId` and `content`.

### 6.6 Rate Limit Retry (FR-5.11)

```typescript
async function retryWithBackoff(
  fn: () => Promise<ChildCallResult>,
  maxRetries: number = 3,
  initialDelayMs: number = 1000,
): Promise<ChildCallResult | null> {
  let delay = initialDelayMs;
  for (let i = 0; i < maxRetries; i++) {
    await sleep(delay);
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err)) throw err;
      delay *= 2;  // Exponential backoff
    }
  }
  return null;  // All retries exhausted
}
```

### 6.7 Cost Estimation (FR-6.6, FR-9.5)

```typescript
class CostEstimator {
  estimateQuery(
    targetIds: string[],
    config: RlmConfig,
    model: Model,
  ): { estimatedCalls: number; estimatedCost: number } {
    // rlm_query joins all targets into ONE child call
    const totalInputTokens = targetIds.reduce((sum, id) => {
      const entry = this.store.getIndexEntry(id);
      return sum + (entry?.tokenEstimate ?? 0);
    }, 0);

    const costPerCall =
      (totalInputTokens * model.cost.input) +
      (config.childMaxTokens * model.cost.output);

    return { estimatedCalls: 1, estimatedCost: costPerCall };
  }

  estimateBatch(
    targetIds: string[],
    config: RlmConfig,
    model: Model,
  ): { estimatedCalls: number; estimatedCost: number } {
    // rlm_batch spawns ONE child per target
    const estimatedCalls = targetIds.length;
    const avgInputTokens = targetIds.reduce((sum, id) => {
      const entry = this.store.getIndexEntry(id);
      return sum + (entry?.tokenEstimate ?? 0);
    }, 0) / Math.max(estimatedCalls, 1);

    const costPerCall =
      (avgInputTokens * model.cost.input) +
      (config.childMaxTokens * model.cost.output);

    return {
      estimatedCalls,
      estimatedCost: estimatedCalls * costPerCall,
    };
  }

  /** Update the actual cost on the CallTree's operation entry. */
  addCallCost(
    operationId: string,
    tokensIn: number,
    tokensOut: number,
    model: Model,
    callTree: CallTree,
  ) {
    const cost =
      (tokensIn * model.cost.input) +
      (tokensOut * model.cost.output);
    const op = callTree.operations.get(operationId);
    if (op) op.actualCost += cost;
  }
}
```

**Dual cost tracking (FR-6.6):** The `estimateQuery()` and `estimateBatch()`
methods compute the **pre-run estimate** (set on the `OperationEntry` via
`registerOperation()`). The `addCallCost()` method accumulates the **running
actual cost** on the same `OperationEntry`. The widget (§10.1) displays both:
`est: $0.0042 actual: $0.0018` — giving the user a before/during view.

Note: `Model.cost` is always present (not optional) per Pi's type definitions.
Values may be 0 for free-tier models, which results in `$0.0000` displays —
acceptable and honest.
```

---

## 7. Tool Implementations

All tools start with `disabledGuard(state)` and wrap their body in
`try/finally` to reset `state.phase`. All tools apply truncation to output
(FR-4.9).

### 7.1 `rlm_peek` (FR-4.1)

**Offset semantics (deviation from FR-4.1):** FR-4.1 specifies "byte/line
offset." The design uses **character offset** because: (a) Pi's built-in `read`
tool uses character/line offsets, not byte offsets, (b) externalized content is
always UTF-8 strings where character indexing via `String.slice()` is natural,
and (c) byte offsets would require Buffer conversion for every peek, adding
complexity with no benefit for text content. **FR-4.1 in requirements.md should
be updated to say "character offset" instead of "byte/line offset."**

```typescript
pi.registerTool({
  name: "rlm_peek",
  label: "RLM Peek",
  description: "Retrieve a slice of an externalized object by ID and character offset.",
  parameters: Type.Object({
    id: Type.String({ description: "Object ID (e.g., rlm-obj-a1b2c3d4)" }),
    offset: Type.Number({ description: "Character offset to start reading", default: 0 }),
    length: Type.Number({ description: "Number of characters to read", default: 2000 }),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const guard = disabledGuard(state);
    if (guard) return guard;

    const obj = state.store.get(params.id);
    if (!obj) return errorResult(`Object ${params.id} not found`);

    const slice = obj.content.slice(params.offset, params.offset + params.length);
    state.warmTracker.markWarm([params.id]);

    const truncation = truncateHead(slice, {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    });

    let text = truncation.content;
    if (truncation.truncated) {
      text += `\n[Output truncated. Object ${params.id} has ${obj.content.length} total chars.]`;
    }
    if (params.offset + params.length < obj.content.length) {
      text += `\n[Showing ${params.offset}–${params.offset + params.length} of ${obj.content.length} chars. Use offset=${params.offset + params.length} to continue.]`;
    }

    return { content: [{ type: "text", text }], details: {} };
  },
});
```

### 7.2 `rlm_search` (FR-4.2)

```typescript
pi.registerTool({
  name: "rlm_search",
  label: "RLM Search",
  description: "Search across externalized objects using a text pattern (substring or regex).",
  parameters: Type.Object({
    pattern: Type.String({ description: "Search pattern (substring or /regex/)" }),
    scope: Type.Optional(Type.Array(Type.String(), { description: "Object IDs to search (default: all)" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const guard = disabledGuard(state);
    if (guard) return guard;

    state.phase = "searching";
    updateWidget(ctx);
    const searchStart = Date.now();

    try {
      const regex = parsePattern(params.pattern);
      const objectIds = params.scope ?? state.store.getAllIds();
      const matches: SearchMatch[] = [];

      for (const id of objectIds) {
        const obj = state.store.get(id);
        if (!obj) continue;

        // Regex timeout via worker_threads (NFR-3.5)
        const objMatches = await searchWithWorkerTimeout(obj.content, regex, id, 5000);
        matches.push(...objMatches);

        if (matches.length >= 50) break;
      }

      state.warmTracker.markWarm(matches.map(m => m.objectId));

      // NFR-4.1: Log non-recursive operations to trajectory
      state.trajectory.append({
        kind: "operation",
        operation: "search",
        objectIds: matches.map(m => m.objectId),
        details: { pattern: params.pattern, matchCount: matches.length },
        wallClockMs: Date.now() - searchStart,
        timestamp: Date.now(),
      });

      const text = formatSearchResults(matches);
      const truncation = truncateHead(text, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      let result = truncation.content;
      if (truncation.truncated) {
        result += `\n[Search results truncated. Use scope parameter to narrow search.]`;
      }

      return { content: [{ type: "text", text: result }], details: {} };
    } finally {
      state.phase = "idle";
      updateWidget(ctx);
    }
  },
});
```

**Regex timeout implementation (NFR-3.5):** JavaScript's regex engine is
synchronous and non-interruptible from the main thread. The design uses
`node:worker_threads` to run regex matching in a separate thread:

```typescript
// search-worker.ts — runs in a Worker thread
import { parentPort, workerData } from "node:worker_threads";
const { content, pattern, flags } = workerData;
const regex = new RegExp(pattern, flags);
const matches = [];
let match;
while ((match = regex.exec(content)) !== null) {
  matches.push({ index: match.index, text: match[0] });
  if (matches.length >= 100) break;
  if (!regex.global) break;
}
parentPort?.postMessage(matches);

// In search.ts
// Worker path: use __dirname for reliable resolution under jiti/hot-reload.
// The extension is loaded via jiti which compiles TypeScript; __dirname
// resolves to the extension's source directory at runtime.
const SEARCH_WORKER_PATH = path.join(__dirname, "search-worker.ts");

async function searchWithWorkerTimeout(
  content: string, regex: RegExp, objectId: string, timeoutMs: number
): Promise<SearchMatch[]> {
  return new Promise((resolve) => {
    const worker = new Worker(SEARCH_WORKER_PATH, {
      workerData: { content, pattern: regex.source, flags: regex.flags },
    });
    const timer = setTimeout(() => {
      worker.terminate();
      resolve([{ objectId, error: "Regex timed out after 5s" }]);
    }, timeoutMs);
    worker.on("message", (matches) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(matches.map(m => ({ objectId, offset: m.index, snippet: m.text })));
    });
    worker.on("error", () => {
      clearTimeout(timer);
      resolve([{ objectId, error: "Regex error" }]);
    });
  });
}
```

### 7.3 `rlm_query` (FR-4.3)

```typescript
pi.registerTool({
  name: "rlm_query",
  label: "RLM Query",
  description: "Spawn a recursive child LLM call focused on specific externalized objects.",
  parameters: Type.Object({
    instructions: Type.String({ description: "What to analyze or answer" }),
    target: Type.Union([
      Type.String({ description: "Single object ID" }),
      Type.Array(Type.String(), { description: "Array of object IDs" }),
    ]),
    model: Type.Optional(Type.String({ description: "Override child model (provider/model-id)" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const guard = disabledGuard(state);
    if (guard) return guard;

    const targetIds = Array.isArray(params.target) ? params.target : [params.target];

    // Cost check (FR-9.5)
    const childModel = resolveChildModel(params.model, state.config, ctx);
    const estimate = state.costEstimator.estimateQuery(targetIds, state.config, childModel);
    if (estimate.estimatedCalls > 10) {
      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "RLM Query",
          `This will spawn ~${estimate.estimatedCalls} child calls (est. $${estimate.estimatedCost.toFixed(4)}). Proceed?`
        );
        if (!ok) return errorResult("Cancelled by user");
      } else {
        console.log(`[pi-rlm] rlm_query: est. ${estimate.estimatedCalls} calls, $${estimate.estimatedCost.toFixed(4)}`);
      }
    }

    state.phase = "querying";
    updateWidget(ctx);

    // Register operation in CallTree — get back an AbortController (FR-9.1)
    const operationId = "rlm-query-" + crypto.randomUUID().slice(0, 8);
    const opController = state.callTree.registerOperation(operationId, estimate.estimatedCost);
    const opTimeout = setTimeout(() => opController.abort(), state.config.operationTimeoutSec * 1000);
    const onAbort = () => opController.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const result = await state.engine.query(
        params.instructions, targetIds, null, 0, operationId, opController.signal, ctx, params.model
      );

      const text = formatChildResult(result);
      const truncation = truncateHead(text, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      let resultText = truncation.content;
      if (truncation.truncated) {
        // FR-4.9: indicate truncation and provide object IDs for retrieval
        resultText += `\n[Output truncated. Target objects: ${targetIds.join(", ")}. ` +
          `Use rlm_peek to retrieve specific content.]`;
      }

      return {
        content: [{ type: "text", text: resultText }],
        details: { result },
      };
    } finally {
      clearTimeout(opTimeout);
      signal?.removeEventListener("abort", onAbort);
      state.callTree.completeOperation(operationId);
      state.phase = "idle";
      updateWidget(ctx);
    }
  },
});
```

### 7.4 `rlm_batch` (FR-4.4)

```typescript
pi.registerTool({
  name: "rlm_batch",
  label: "RLM Batch",
  description: "Spawn parallel child LLM calls across multiple externalized objects.",
  parameters: Type.Object({
    instructions: Type.String({ description: "What to analyze on each object" }),
    targets: Type.Array(Type.String(), { description: "Array of object IDs" }),
    model: Type.Optional(Type.String({ description: "Override child model" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const guard = disabledGuard(state);
    if (guard) return guard;

    // Cost check
    const childModel = resolveChildModel(params.model, state.config, ctx);
    const estimate = state.costEstimator.estimateBatch(params.targets, state.config, childModel);
    if (estimate.estimatedCalls > 10) {
      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "RLM Batch",
          `This will spawn ~${estimate.estimatedCalls} parallel calls (est. $${estimate.estimatedCost.toFixed(4)}). Proceed?`
        );
        if (!ok) return errorResult("Cancelled by user");
      } else {
        console.log(`[pi-rlm] rlm_batch: est. ${estimate.estimatedCalls} calls, $${estimate.estimatedCost.toFixed(4)}`);
      }
    }

    state.phase = "batching";
    updateWidget(ctx);

    // Register operation in CallTree — get back an AbortController (FR-9.1)
    const operationId = "rlm-batch-" + crypto.randomUUID().slice(0, 8);
    const opController = state.callTree.registerOperation(operationId, estimate.estimatedCost);
    const opTimeout = setTimeout(() => opController.abort(), state.config.operationTimeoutSec * 1000);
    const onAbort = () => opController.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const results = await state.engine.batch(
        params.instructions, params.targets, null, 0, opController.signal, ctx, params.model
      );

      state.phase = "synthesizing";
      updateWidget(ctx);

      const summary = results.map((r, i) => {
        const id = params.targets[i];
        return `### ${id}\n**Confidence:** ${r.confidence}\n${r.answer}`;
      }).join("\n\n");

      const truncation = truncateHead(summary, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      let text = truncation.content;
      if (truncation.truncated) {
        // FR-4.9: indicate truncation and provide object IDs for retrieval
        text += `\n[Results truncated. ${results.length} objects processed. ` +
          `Target IDs: ${params.targets.join(", ")}. Use rlm_peek for specific content.]`;
      }

      return {
        content: [{ type: "text", text }],
        details: { results },
      };
    } finally {
      clearTimeout(opTimeout);
      signal?.removeEventListener("abort", onAbort);
      state.callTree.completeOperation(operationId);
      state.phase = "idle";
      updateWidget(ctx);
    }
  },
});
```

### 7.5 `rlm_ingest` (FR-4.6)

```typescript
pi.registerTool({
  name: "rlm_ingest",
  label: "RLM Ingest",
  description: "Ingest files directly into the external store without reading them into working context. Use for whole-codebase operations.",
  parameters: Type.Object({
    paths: Type.Array(Type.String(), { description: "File paths or globs to ingest" }),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const guard = disabledGuard(state);
    if (guard) return guard;

    state.phase = "ingesting";
    updateWidget(ctx);

    try {
      // resolveGlobs: expand glob patterns relative to cwd, return absolute paths.
      // Uses Node's built-in fs.glob() (Node 22+) or a simple readdir+minimatch fallback.
      // Skips: node_modules, .git, binary files (detected via null-byte check on first 512 bytes).
      const resolvedPaths = await resolveGlobs(params.paths, ctx.cwd);
      const objectIds: string[] = [];

      for (const filePath of resolvedPaths) {
        if (signal?.aborted) break;

        try {
          const content = await fs.promises.readFile(filePath, "utf-8");
          const obj = state.store.add({
            type: "file",
            description: path.relative(ctx.cwd, filePath),
            content,
            source: { kind: "ingested", path: filePath },
          });
          objectIds.push(obj.id);

          onUpdate?.({
            content: [{ type: "text", text: `Ingested ${objectIds.length}/${resolvedPaths.length}: ${filePath}` }],
          });
        } catch (err) {
          // Skip unreadable files, continue
        }
      }

      const text = `Ingested ${objectIds.length} files. Object IDs:\n${objectIds.join("\n")}`;
      const truncation = truncateHead(text, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      return {
        content: [{ type: "text", text: truncation.content }],
        details: { objectIds },
      };
    } finally {
      state.phase = "idle";
      updateWidget(ctx);
    }
  },
});
```

### 7.5.1 `resolveGlobs` Helper

```typescript
import { glob } from "node:fs/promises";  // Node 22+

const DEFAULT_IGNORES = ["**/node_modules/**", "**/.git/**"];

async function resolveGlobs(
  patterns: string[],
  cwd: string,
): Promise<string[]> {
  const results: string[] = [];
  for (const pattern of patterns) {
    // Node 22+ fs.glob supports glob patterns natively
    for await (const entry of glob(pattern, { cwd, exclude: DEFAULT_IGNORES })) {
      const abs = path.resolve(cwd, entry);
      const stat = await fs.promises.stat(abs).catch(() => null);
      if (!stat || !stat.isFile()) continue;

      // Skip binary files: check first 512 bytes for null bytes
      const fd = await fs.promises.open(abs, "r");
      const buf = Buffer.alloc(512);
      const { bytesRead } = await fd.read(buf, 0, 512, 0);
      await fd.close();
      if (buf.subarray(0, bytesRead).includes(0)) continue;  // Binary file

      results.push(abs);
    }
  }
  return [...new Set(results)];  // Deduplicate
}
```

### 7.6 `rlm_stats` (FR-4.5)

```typescript
pi.registerTool({
  name: "rlm_stats",
  label: "RLM Stats",
  description: "Show current RLM state: externalized objects, token usage, active operations.",
  parameters: Type.Object({}),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const guard = disabledGuard(state);
    if (guard) return guard;

    const index = state.store.getFullIndex();
    const usage = ctx.getContextUsage();
    const activeOps = state.callTree.getActive();

    const text = [
      `RLM Status: ${state.enabled ? "ON" : "OFF"}`,
      `Externalized objects: ${index.objects.length}`,
      `Total tokens in store: ${index.totalTokens.toLocaleString()}`,
      `Working context: ${usage?.tokens?.toLocaleString() ?? "unknown"} tokens`,
      `Active child calls: ${activeOps.length}`,
      `Current depth: ${state.callTree.maxActiveDepth()}`,
      `Config: maxDepth=${state.config.maxDepth}, maxConcurrency=${state.config.maxConcurrency}, maxChildCalls=${state.config.maxChildCalls}`,
    ].join("\n");

    // rlm_stats output is already small — truncation applied for consistency
    const truncation = truncateHead(text, {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    });

    return { content: [{ type: "text", text: truncation.content }], details: {} };
  },
});
```

---

## 8. Command Implementations

### 8.1 MUST Commands (FR-8.1)

```typescript
function registerCommands(pi: ExtensionAPI, state: RlmState) {
  pi.registerCommand("rlm", {
    description: "RLM status and control. Usage: /rlm [on|off]",
    handler: async (args, ctx) => {
      const subcommand = args?.trim().toLowerCase();

      if (subcommand === "on") {
        state.enabled = true;
        state.config.enabled = true;
        pi.appendEntry("rlm-config", state.config);
        updateWidget(ctx);
        if (ctx.hasUI) {
          ctx.ui.notify("RLM enabled. Context externalization is active.", "success");
        }
        return;
      }

      if (subcommand === "off") {
        // Cancel any in-flight operations via CallTree's AbortController registry (FR-9.1)
        state.callTree.abortAll();
        state.enabled = false;
        state.config.enabled = false;
        state.allowCompaction = false;  // Reset safety valve
        pi.appendEntry("rlm-config", state.config);
        updateWidget(ctx);
        if (ctx.hasUI) {
          ctx.ui.notify(
            "RLM disabled. Pi will use standard compaction. External store preserved on disk.",
            "info"
          );
        }
        return;
      }

      // Default: show status
      const index = state.store.getFullIndex();
      const usage = ctx.getContextUsage();
      const activeOps = state.callTree.getActive();
      const lines = [
        `RLM: ${state.enabled ? "ON" : "OFF"}`,
        `External store: ${index.objects.length} objects, ${formatTokens(index.totalTokens)}`,
        `Working context: ${usage?.tokens?.toLocaleString() ?? "unknown"} tokens`,
      ];
      if (activeOps.length > 0) {
        lines.push(`Active operations: ${activeOps.length}`);
      }
      if (ctx.hasUI) {
        ctx.ui.notify(lines.join("\n"), "info");
      } else {
        console.log(`[pi-rlm] ${lines.join(" | ")}`);
      }
    },
  });
}
```

**`/rlm cancel` — Cancel active operations (FR-9.1):**

The `/rlm` command also handles `cancel` as a subcommand. This is separate
from `/rlm off` because it cancels in-flight operations without disabling RLM:

```typescript
      if (subcommand === "cancel") {
        const activeOps = state.callTree.getActive();
        if (activeOps.length === 0) {
          if (ctx.hasUI) ctx.ui.notify("No active RLM operations.", "info");
          return;
        }
        state.callTree.abortAll();
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Cancelled ${activeOps.length} active operation(s). Partial results preserved.`,
            "warning"
          );
        }
        return;
      }
```

**Cancellation wiring (FR-9.1):** When `/rlm cancel` or `/rlm off` calls
`callTree.abortAll()`, each registered `OperationEntry.controller.abort()` is
invoked. This propagates via the `AbortSignal` chain:

```
callTree.abortAll()
  → OperationEntry.controller.abort()          [registered by rlm_query/rlm_batch]
    → opController.signal triggers onAbort
      → childController.abort()                [per-child, created in engine.query()]
        → complete()/stream() receives abort   [pi-ai honors AbortSignal]
```

The signal chain uses `{ once: true }` listeners to prevent memory leaks
(§6.3 step 8). Partial results from already-completed children are preserved
and returned to the LLM.

### 8.2 SHOULD Commands (FR-8.2) — Phase 4

```typescript
// /rlm config — show/edit settings
// /rlm inspect — open inspector overlay
// /rlm externalize — force immediate externalization
// /rlm store — show store contents
// Implementations follow the same pattern as /rlm above.
// /rlm inspect calls showInspector(ctx) from §10.2.
// /rlm externalize sets state.phase = "externalizing" and triggers
// the externalization algorithm on the next context event.
```

---

## 9. System Prompt Template

### 9.1 Root System Prompt Injection (FR-11)

Injected via `before_agent_start` when RLM is enabled. The manifest is NOT
included here — it's injected in the `context` handler (§4.4) so it reflects
the current turn's externalization state.

```typescript
function buildSystemPrompt(config: RlmConfig): string {
  return `
## RLM (Recursive Language Model) Environment

You are operating in an RLM-augmented environment. Large content from this
session has been externalized to an external store and replaced with compact
references in your context. You have full access to all externalized content
via RLM tools.

### Available Tools

- **rlm_peek(id, offset, length)** — Read a slice of an externalized object.
  Fast, no LLM call. Use for quick lookups.
- **rlm_search(pattern, scope?)** — Search across externalized objects by
  text or regex. Fast, no LLM call. Use to find relevant content.
- **rlm_query(instructions, target, model?)** — Spawn a focused child LLM
  call on specific objects. Use for complex analysis that requires reasoning,
  not just retrieval. Costs tokens and time.
- **rlm_batch(instructions, targets, model?)** — Spawn parallel child calls
  across multiple objects. Use for map-reduce patterns over many files.
  Costs tokens proportional to target count.
- **rlm_ingest(paths)** — Read files directly into the external store without
  loading them into your context. Use before batch operations on many files.
- **rlm_stats()** — View current RLM state (object count, token usage, etc.).

### When to Use RLM Tools vs Direct Tools

- **Small, specific lookups** → Use \`read\`, \`bash\`, \`grep\` directly.
- **Content you already externalized** → Use \`rlm_peek\` or \`rlm_search\`.
- **Complex analysis of externalized content** → Use \`rlm_query\`.
- **Processing many files systematically** → Use \`rlm_ingest\` then \`rlm_batch\`.
- **Finding where something is** → Use \`rlm_search\` across the store.

### Exploration Strategies

Express exploration through tool-call chaining, not code generation:

1. **Search-then-peek:** \`rlm_search("error")\` → find matches → \`rlm_peek(id)\`
   to read context around each match.
2. **Ingest-partition-query:** \`rlm_ingest(["src/**/*.ts"])\` → \`rlm_batch\` with
   analysis instructions across all ingested files.
3. **Iterative drill-down:** \`rlm_query\` on a large object → if the child
   identifies a sub-area of interest, follow up with \`rlm_peek\` on that area.

### Important

- RLM operations cost tokens. Prefer direct tools for simple tasks.
- When the user references something you don't have in context, search for it
  in the external store BEFORE saying you don't have it. The user sees the full
  conversation; you see a pruned version.
- When you retrieve externalized content, verify it matches what the user is
  referring to before relying on it.
- Each rlm_query/rlm_batch call has a budget and timeout. The system will
  cancel operations that exceed limits and return partial results.
`.trim();
}
```

### 9.2 Child System Prompt

```typescript
function buildChildSystemPrompt(
  instructions: string,
  depth: number,
  config: RlmConfig,
): string {
  const canRecurse = depth < config.maxDepth;
  const toolNote = canRecurse
    ? "You have access to rlm_peek, rlm_search, and rlm_query for further exploration."
    : "You have access to rlm_peek and rlm_search. You cannot spawn further child calls.";

  return `
You are an RLM child analyzer at depth ${depth + 1}/${config.maxDepth}.
Your task: ${instructions}

The content to analyze is provided in the user message below.

${toolNote}

Respond with a JSON object:
{
  "answer": "Your analysis/answer as a string",
  "confidence": "high" | "medium" | "low",
  "evidence": ["relevant quote 1", "relevant quote 2"]
}

Be concise. Focus on answering the specific question. Do not explain your
reasoning process — just provide the answer with supporting evidence.
`.trim();
}
```

---

## 10. Widget Rendering

### 10.1 Widget States (FR-6)

```typescript
import { Text } from "@mariozechner/pi-tui";

function updateWidget(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;

  ctx.ui.setWidget("rlm", (tui, theme) => {
    if (!state.enabled) {
      // FR-6.2: Off state
      return new Text(theme.fg("dim", "RLM: off"), 0, 0);
    }

    const index = state.store.getFullIndex();

    if (state.phase === "idle") {
      // FR-6.3: On-idle state (FR-14.2: includes /rlm off hint)
      const tokens = formatTokens(index.totalTokens);
      const text = theme.fg("accent", "RLM: on") +
        theme.fg("muted", ` (${index.objects.length} objects, ${tokens})`) +
        theme.fg("dim", " | /rlm off to disable");
      return new Text(text, 0, 0);
    }

    // FR-6.4: Active state
    const active = state.callTree.getActive();
    const depth = state.callTree.maxActiveDepth();
    // Per-operation budget from active operation (if any)
    const activeOp = [...state.callTree.operations.values()][0]; // Most recent
    const budget = activeOp
      ? `${activeOp.childCallsUsed}/${state.config.maxChildCalls}`
      : "0";
    // FR-6.6: Show BOTH estimated cost (pre-run) and actual cost (running)
    const estCost = activeOp?.estimatedCost ?? 0;
    const actCost = activeOp?.actualCost ?? 0;
    const costStr = estCost > 0 || actCost > 0
      ? ` | est: $${estCost.toFixed(4)} actual: $${actCost.toFixed(4)}`
      : "";

    const lines = [
      theme.fg("warning", `RLM: ${state.phase}`) +
        theme.fg("muted", ` | depth: ${depth} | children: ${active.length} | budget: ${budget}${costStr}`),
    ];

    // FR-6.5: Token counts
    const usage = ctx.getContextUsage();
    if (usage && usage.tokens !== null) {
      lines.push(
        theme.fg("dim", `  context: ${usage.tokens.toLocaleString()} tokens | store: ${formatTokens(index.totalTokens)}`)
      );
    } else {
      lines.push(
        theme.fg("dim", `  context: unknown | store: ${formatTokens(index.totalTokens)}`)
      );
    }

    return new Text(lines.join("\n"), 0, 0);
  });
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tokens`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K tokens`;
  return `${n} tokens`;
}
```

### 10.2 Inspector Overlay (FR-7)

```typescript
async function showInspector(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;

  await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    const tree = state.callTree.getTree();

    function renderNode(node: CallNode, indent: number): string {
      const prefix = "  ".repeat(indent);
      const status = node.status === "running"
        ? theme.fg("warning", "●")
        : node.status === "success"
          ? theme.fg("success", "✓")
          : theme.fg("error", "✗");
      const time = node.wallClockMs ? `${node.wallClockMs}ms` : "...";
      const tokens = node.tokensIn + node.tokensOut;
      return `${prefix}${status} ${node.callId} [${node.model}] ${time} ${tokens}tok\n` +
        `${prefix}  ${theme.fg("dim", node.query.slice(0, 60))}`;
    }

    const lines = ["RLM Inspector — Press Escape to close\n"];
    function walk(nodes: CallNode[], indent: number) {
      for (const node of nodes) {
        lines.push(renderNode(node, indent));
        walk(node.children, indent + 1);
      }
    }
    walk(tree, 0);

    const text = new Text(lines.join("\n"), 1, 1);
    text.onKey = (key) => {
      if (key === "escape") done();
      return true;
    };
    return text;
  }, { overlay: true });
}
```

---

## 11. Configuration and Persistence

### 11.1 Config Persistence

Configuration is persisted via `pi.appendEntry()` and reconstructed on
`session_start`:

```typescript
// Save config change
function updateConfig(changes: Partial<RlmConfig>) {
  state.config = { ...state.config, ...changes };
  pi.appendEntry("rlm-config", state.config);
  updateWidget(ctx);
}

// Reconstruct on session_start (see §4.2)
// Latest rlm-config entry wins (appendEntry is append-only, last value used)
```

### 11.2 Store Persistence

The external store uses a dual-persistence model:

1. **Disk store** (source of truth): `.pi/rlm/<session-id>/store.jsonl` + `index.json`
2. **Session entries** (lightweight metadata): `pi.appendEntry("rlm-index", indexSnapshot)`

**Manifest persistence (FR-12.1):** FR-12.1 requires persisting "store index
snapshot, configuration, current manifest." The manifest is **not** persisted
separately because it is deterministically reconstructable from the store index
via `ManifestBuilder.build()`. Persisting it would create a stale-data risk
(manifest out of sync with index). Instead, the manifest is rebuilt on
`session_start` after the index is loaded. **FR-12.1 in requirements.md should
be updated to replace "current manifest" with "store index snapshot and
configuration (manifest is deterministically rebuilt from the index)."**

On `session_start`:
1. Check if disk store exists at `.pi/rlm/<session-id>/`
2. If yes: load `index.json`. If index is missing or corrupt, rebuild from
   `store.jsonl` by reading line-by-line.
3. If no: create directory, initialize empty store.
4. Rebuild manifest from loaded index (deterministic, no persistence needed).

The `WriteQueue` serializes all writes:

```typescript
class WriteQueue {
  private queue: Promise<void> = Promise.resolve();

  async enqueue(fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(fn).catch((err) => {
      console.error("[pi-rlm] WriteQueue error:", err);
      // Surface to state for degradation check
      state.storeHealthy = false;
    });
    return this.queue;
  }
}
```

All `store.add()`, `store.flush()`, and index writes go through the queue.

**`store.add()` contract:** Updates in-memory index synchronously (returns
`StoreRecord` immediately). Enqueues JSONL line append + `index.json` rewrite
to `WriteQueue`. If `WriteQueue` reports an error, `state.storeHealthy` is
set false, and the next context handler call will check this flag and fall
back to allowing compaction.

### 11.3 Large Store Performance (FR-1.6)

FR-1.6 (SHOULD) requires the store to support content over 10MB per session.
The design handles this through architectural choices:

1. **JSONL + index file:** The `index.json` file provides O(1) lookup by ID
   (via in-memory `Map`) and O(n) scanning for search without parsing the
   entire JSONL file. Each `StoreIndexEntry` includes `byteOffset` and
   `byteLength` for direct `fs.read()` seeks into `store.jsonl`, avoiding
   full-file reads for `rlm_peek`.

2. **Streaming search:** `rlm_search` processes objects one at a time via
   worker threads, never loading the entire store into memory simultaneously.
   The 50-match cap (§7.2) bounds memory usage during search.

3. **Index memory pressure:** At 10MB of content (~2,500 tokens/KB × 10MB =
   ~2.5M tokens), the index holds ~500–2,000 `StoreIndexEntry` objects
   (assuming average 5–20KB per object). Each entry is ~200 bytes, so the
   index fits in <1MB of memory. This scales comfortably to 100MB+ stores.

4. **Manifest truncation:** The manifest (§3.3) shows only the most recent
   entries within its token budget, collapsing older entries into a summary
   line. Large stores don't produce large manifests.

5. **No in-memory content cache:** Content is stored only on disk (in
   `store.jsonl`) and read on demand via byte-offset seeks. The in-memory
   index contains only metadata. This keeps memory usage proportional to
   object count, not content size.

**Performance targets for 10MB+ stores:**
- `rlm_peek`: <50ms (single `fs.read` at byte offset)
- `rlm_search` (substring): <2s (streaming scan with worker threads)
- `rlm_search` (regex): <5s per object (worker thread timeout, §7.2)
- Manifest generation: <10ms (index scan, no disk I/O)
- Externalization (context handler): <100ms (in-memory index update is sync)

### 11.4 Store Cleanup (FR-1.8)

On `session_start`, scan `.pi/rlm/` for session directories. Delete any
older than `config.retentionDays`. This runs asynchronously and does not
block startup (NFR-2.2):

```typescript
async function cleanupOldSessions(rlmDir: string, retentionDays: number) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const entries = await fs.promises.readdir(rlmDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const indexPath = path.join(rlmDir, entry.name, "index.json");
    try {
      const stat = await fs.promises.stat(indexPath);
      if (stat.mtimeMs < cutoff) {
        await fs.promises.rm(path.join(rlmDir, entry.name), { recursive: true });
      }
    } catch {} // Skip if can't read
  }
}
```

---

## 12. Error Handling Strategy

### 12.1 Principle: Fail Safe, Never Crash Pi

Two wrapper patterns — one for event handlers, one for tools:

```typescript
// For event handlers: return undefined on error (Pi uses defaults)
function safeHandler<T>(name: string, fn: (...args: any[]) => Promise<T>) {
  return async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error(`[pi-rlm] ${name} error:`, err);
      return undefined;
    }
  };
}

// For tools: return error result on error (LLM sees the error)
function safeToolExecute(
  name: string,
  fn: (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<ToolResult>,
) {
  return async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
    try {
      return await fn(toolCallId, params, signal, onUpdate, ctx);
    } catch (err) {
      console.error(`[pi-rlm] ${name} error:`, err);
      return {
        content: [{ type: "text" as const, text: `RLM error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  };
}
```

### 12.2 Graceful Degradation (FR-13)

```
Error in context handler → return undefined (Pi uses unmodified messages)
Error in compact handler → return undefined (Pi compacts normally)
Error in tool execution → return { content: [{ type: "text", text: error }], isError: true }
Error in store → log, set state.storeHealthy = false, notify user
Error in child call → return structured error result, continue batch
```

### 12.3 Specific Error Cases

| Error | Response |
|-------|----------|
| Store JSONL corrupt | Rebuild index from valid lines, skip corrupt lines |
| `stream()` / `complete()` throws | Return error ChildCallResult, log to trajectory |
| Rate limit (429) | Retry 3x with exponential backoff (FR-5.11) |
| Child timeout | Abort via AbortSignal, return timeout result |
| Operation budget exceeded | `opController.abort()`, return partial results |
| Regex catastrophic backtracking | Worker thread terminated after 5s (NFR-3.5) |
| Disk full / store write error | Log, set `storeHealthy = false`, allow compaction |
| `ctx.getContextUsage()` returns undefined | Skip externalization, still replace stubs + inject manifest |
| `ctx.getContextUsage().tokens` is null | Skip externalization (tokens unknown, e.g., post-compaction), still replace stubs + inject manifest |
| Model has no cost metadata | Use 0 for estimates, note "cost unknown" in widget |
| `complete()` unavailable | Fall back to `stream()` + collect full response |

---

## 13. Implementation Phases

**Phase sequencing rationale:** Requirements R-1 mitigation says "Start with
batch-like operations … Extend to interactive context management only after
validating the core engine." The phases below invert this: Phase 1 implements
context externalization, Phase 2 adds the recursive engine. This is a
deliberate deviation for practical reasons:

1. **Dependency ordering:** The recursive engine (`rlm_query`, `rlm_batch`)
   needs content in the store to operate on. Context externalization is the
   primary path for populating the store during normal sessions. Building
   externalization first means Phase 2 has real data to test against.

2. **Risk mitigation is still addressed:** Phase 1 includes `rlm_peek` and
   `rlm_search` (non-recursive tools) which validate the store and retrieval
   path. Phase 2 includes `rlm_ingest` which provides a batch-like path to
   populate the store without externalization, enabling pure batch testing.

3. **Fastest path to validation:** The single riskiest assumption (A-1) is
   that Pi's `context` event supports message modification, compaction
   cancellation, and child LLM calls. Phase 1 proves all three together.
   If any of these fail, the entire project pivots — learning this in week 1
   is better than week 3.

### Phase 1: Proof of Concept (1–2 weeks)

**Goal:** Validate that the core extension hooks work as designed. Prove that
`context` event modification, compaction cancellation, and `complete()`/
`stream()` child calls all function correctly together.

**Deliverables:**
1. Extension skeleton (`index.ts`) with event handler wiring + `safeHandler`
2. `ExternalStore` — JSONL read/write with in-memory index + `WriteQueue`
3. `ContextExternalizer` — `context` handler: stub replacement, externalization,
   manifest injection
4. `countMessageTokens()` utility
5. Compaction interceptor — `session_before_compact` returns `{ cancel: true }`
6. `rlm_peek` — retrieve slice from store
7. `rlm_search` — substring search (no regex timeout yet)
8. `ManifestBuilder` — manifest injected into message array
9. Basic widget — shows off/idle states
10. `/rlm`, `/rlm on`, `/rlm off`, `/rlm cancel` commands
11. `disabledGuard()` on all tools
12. Unit tests for `ExternalStore`, `ManifestBuilder`, `countMessageTokens`

**Validation:** Run Pi with the extension, have a long conversation, verify
compaction never fires, verify `rlm_peek` retrieves externalized content,
verify the model sees stubs and manifest in the correct turn.

### Phase 2: Recursive Engine (1–2 weeks)

**Goal:** Implement `rlm_query` and `rlm_batch` with the full recursive call
engine, cost estimation, and budget controls.

**Deliverables:**
1. `RecursiveEngine` with `query()` and `batch()` methods
2. `ConcurrencyLimiter` for parallel execution
3. `resolveChildModel()` with `provider/model-id` parsing
4. `rlm_query` and `rlm_batch` tools with cost confirmation + non-UI logging
5. `rlm_ingest` tool (needed for batch testing)
6. `CallTree` for tracking active operations
7. `TrajectoryLogger` — JSONL logging of all recursive calls
8. `CostEstimator` with `estimateQuery()` and `estimateBatch()` (separate)
9. Child system prompt with structured output instructions
10. Budget limits and timeouts via `AbortSignal` + `{ once: true }` listeners
11. Widget active state — shows phase, depth, child count, budget, cost
12. Unit tests for `RecursiveEngine`, `ConcurrencyLimiter`, `CostEstimator`

**Validation:** Run `rlm_query` on externalized content and verify child
calls return structured results. Run `rlm_batch` across multiple objects and
verify parallel execution. Verify budget cancellation and timeout behavior.

### Phase 3: Robustness (1 week)

**Goal:** Harden the extension for real-world use. Add safety valves,
warm tracking, retry logic, and error handling.

**Deliverables:**
1. Safety valve (FR-3.8) — force-externalize at 90%, fallback to compaction
2. `WarmTracker` — tracks object IDs, prevents re-externalization
3. Rate-limit retry with exponential backoff (FR-5.11)
4. Child response validation and fallback wrapping (FR-5.12)
5. Regex timeout via `worker_threads` for `rlm_search` (NFR-3.5)
6. `safeToolExecute` wrapper on all tool executors (NFR-3.1)
7. Store health tracking (`storeHealthy` flag) + degradation (FR-13)
8. First-run notification via file flag (FR-14)
9. `try/finally` on all tool executors for phase reset
10. Unit tests for `WarmTracker`, regex timeout, retry logic

**Validation:** Run stress tests — many concurrent `rlm_batch` children,
rapid externalization/retrieval cycles, large stores, model errors, ReDoS
patterns.

### Phase 4: Polish (1 week)

**Goal:** Complete the UI layer, add remaining tools and commands, and prepare
for general use.

**Deliverables:**
1. Inspector overlay (FR-7) via `ctx.ui.custom()` with overlay mode
2. `/rlm config`, `/rlm inspect`, `/rlm externalize`, `/rlm store` commands
3. `/rlm trace`, `/rlm clear` commands
4. `rlm_stats` tool
5. `rlm_extract` tool (MAY)
6. Session resume — reference previous session's store (FR-12.3)
7. Tunable system prompt via config file (FR-11.5)
8. Model routing configuration (FR-5.7, FR-9.4)
9. Non-interactive mode support — check `ctx.hasUI` (NFR-1.5)
10. `pi.events` emission for inter-extension communication (NFR-4.3)

---

## 14. Testing Strategy

### 14.1 Test Levels

The testing strategy has three levels. **All three run on every push** — there
is no "optional" tier. If the model can't use the tools correctly with a real
LLM, the extension is broken and we need to know immediately, not after a user
reports it.

| Level | What it catches | Runs against | Speed |
|-------|----------------|-------------|-------|
| **Unit** | Logic bugs in isolated components | Mock objects, no Pi | <1s per test |
| **Component** | Wiring bugs between extension modules | Mock Pi API surface | <2s per test |
| **E2E** | Everything else: real Pi, real model, real externalization, real retrieval | Pi RPC mode + live LLM | 30–120s per test |

The E2E tests are the most important tier. Unit and component tests catch
regressions fast, but only E2E tests answer the question: "Does the model
actually use RLM correctly to maintain infinite context?" Pi's agent is
already configured with model providers — no separate API key setup is needed.

### 14.2 Test Infrastructure

**Framework:** Vitest (already a Pi ecosystem standard, zero config with
TypeScript, built-in mocking, watch mode).

**Project structure:**

```
pi-rlm/
├── vitest.config.ts
├── tests/
│   ├── helpers/
│   │   ├── mock-pi.ts           # Mock ExtensionAPI, ExtensionContext factories
│   │   ├── mock-store.ts        # Pre-populated ExternalStore for testing
│   │   ├── mock-messages.ts     # AgentMessage factories (user, assistant, toolResult)
│   │   ├── pi-harness.ts        # RPC-mode test harness for e2e tests
│   │   └── assertions.ts        # Custom matchers (toBeExternalized, toHaveStub, etc.)
│   ├── unit/
│   │   ├── store.test.ts
│   │   ├── manifest.test.ts
│   │   ├── fingerprint.test.ts
│   │   ├── warm-tracker.test.ts
│   │   ├── call-tree.test.ts
│   │   ├── concurrency.test.ts
│   │   ├── cost-estimator.test.ts
│   │   ├── write-queue.test.ts
│   │   └── tokens.test.ts
│   ├── component/
│   │   ├── externalizer.test.ts
│   │   ├── context-handler.test.ts
│   │   ├── compaction-intercept.test.ts
│   │   ├── tools-peek.test.ts
│   │   ├── tools-search.test.ts
│   │   ├── tools-query.test.ts
│   │   ├── tools-batch.test.ts
│   │   ├── tools-ingest.test.ts
│   │   ├── commands.test.ts
│   │   └── widget.test.ts
│   └── e2e/
│       ├── scenario-long-session.test.ts
│       ├── scenario-ingest-and-analyze.test.ts
│       ├── scenario-cross-turn-retrieval.test.ts
│       ├── scenario-session-resume.test.ts
│       ├── scenario-cancel-mid-operation.test.ts
│       ├── scenario-disable-enable.test.ts
│       └── scenario-no-confabulation.test.ts
```

**Vitest config:**

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: true,
    testTimeout: 10_000,           // Unit/component: 10s
    hookTimeout: 30_000,
    // Separate integration/LLM tests by tag
    typecheck: { enabled: true },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/ui/**"],  // UI tests are manual
      thresholds: {
        lines: 80,
        branches: 75,
        functions: 80,
      },
    },
  },
});
```

### 14.3 Mock Factories

These factories create typed mocks of Pi's API surface, enabling component
tests without a running Pi instance.

```typescript
// tests/helpers/mock-messages.ts
import type { AgentMessage } from "@mariozechner/pi-agent-core";

let msgCounter = 0;

/** Create a user message with a unique timestamp. */
export function userMsg(text: string, timestamp?: number): AgentMessage {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: timestamp ?? Date.now() + (msgCounter++),
  };
}

/** Create an assistant message with a unique timestamp. */
export function assistantMsg(text: string, timestamp?: number): AgentMessage {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "anthropic-messages" as any,
    provider: "anthropic",
    model: "test-model",
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0,
             cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop" as const,
    timestamp: timestamp ?? Date.now() + (msgCounter++),
  };
}

/** Create a tool result message with a unique toolCallId. */
export function toolResultMsg(
  toolName: string,
  text: string,
  toolCallId?: string,
): AgentMessage {
  return {
    role: "toolResult" as const,
    toolCallId: toolCallId ?? `call_${msgCounter++}`,
    toolName,
    content: [{ type: "text" as const, text }],
    isError: false,
    timestamp: Date.now() + (msgCounter++),
  };
}

/** Create a large tool output (for externalization tests). */
export function largeToolResult(sizeChars: number): AgentMessage {
  return toolResultMsg("bash", "x".repeat(sizeChars));
}
```

```typescript
// tests/helpers/mock-pi.ts
import type {
  ExtensionAPI, ExtensionContext, ExtensionUIContext, ContextUsage,
} from "@mariozechner/pi-coding-agent";

/** Create a mock ExtensionContext with configurable overrides. */
export function mockCtx(overrides?: {
  tokens?: number | null;
  contextWindow?: number;
  hasUI?: boolean;
  cwd?: string;
}): ExtensionContext {
  const tokens = overrides?.tokens ?? 50_000;
  const contextWindow = overrides?.contextWindow ?? 200_000;

  return {
    hasUI: overrides?.hasUI ?? false,
    cwd: overrides?.cwd ?? "/tmp/test",
    model: {
      id: "test-model", name: "Test", api: "anthropic-messages" as any,
      provider: "test", baseUrl: "", reasoning: false, input: ["text"],
      cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow, maxTokens: 8192,
    } as any,
    modelRegistry: { find: () => null } as any,
    sessionManager: {
      getSessionFile: () => "test-session",
      getEntries: () => [],
      getBranch: () => [],
    } as any,
    ui: mockUI(),
    isIdle: () => true,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: (): ContextUsage | undefined =>
      tokens === null ? { tokens: null, contextWindow, percent: null }
        : { tokens, contextWindow, percent: (tokens / contextWindow) * 100 },
    compact: () => {},
    getSystemPrompt: () => "",
  };
}

function mockUI(): ExtensionUIContext {
  return {
    select: async () => undefined,
    confirm: async () => true,
    input: async () => undefined,
    notify: () => {},
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined as any,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    setEditorComponent: () => {},
    theme: {} as any,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
}

/** Create a mock ExtensionAPI that records registrations. */
export function mockPi(): ExtensionAPI & {
  _handlers: Map<string, Function[]>;
  _tools: Map<string, any>;
  _commands: Map<string, any>;
  _entries: Array<{ type: string; data: any }>;
} {
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const entries: Array<{ type: string; data: any }> = [];

  return {
    _handlers: handlers,
    _tools: tools,
    _commands: commands,
    _entries: entries,
    on: (event: string, handler: Function) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    registerTool: (def: any) => { tools.set(def.name, def); },
    registerCommand: (name: string, opts: any) => { commands.set(name, opts); },
    appendEntry: (type: string, data: any) => { entries.push({ type, data }); },
    events: { on: () => {}, emit: () => {} } as any,
    // Stubs for other methods:
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    getCommands: () => [],
    setModel: async () => true,
    getThinkingLevel: () => "off" as any,
    setThinkingLevel: () => {},
    registerProvider: () => {},
  } as any;
}
```

### 14.4 Unit Test Specifications

Each unit test file covers one module in isolation:

**`tests/unit/store.test.ts`** — Phase 1

```typescript
describe("ExternalStore", () => {
  let store: ExternalStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rlm-test-"));
    store = new ExternalStore(tmpDir);
    await store.initialize();
  });

  afterEach(() => fs.promises.rm(tmpDir, { recursive: true }));

  it("add() returns a StoreRecord with unique ID", () => {
    const obj = store.add({
      type: "file", description: "test.ts", content: "const x = 1;",
      source: { kind: "ingested", path: "/tmp/test.ts" },
    });
    expect(obj.id).toMatch(/^rlm-obj-/);
    expect(obj.tokenEstimate).toBe(Math.ceil(12 / 4)); // "const x = 1;" = 12 chars
  });

  it("get() retrieves content by ID", () => {
    const obj = store.add({ type: "file", description: "test", content: "hello",
      source: { kind: "ingested", path: "/tmp/test" } });
    expect(store.get(obj.id)?.content).toBe("hello");
  });

  it("get() returns null for unknown ID", () => {
    expect(store.get("rlm-obj-nonexistent")).toBeNull();
  });

  it("getFullIndex() reflects all added objects", () => {
    store.add({ type: "file", description: "a", content: "aaa",
      source: { kind: "ingested", path: "/a" } });
    store.add({ type: "file", description: "b", content: "bbb",
      source: { kind: "ingested", path: "/b" } });
    const index = store.getFullIndex();
    expect(index.objects).toHaveLength(2);
    expect(index.totalTokens).toBe(2); // ceil(3/4) + ceil(3/4) = 1 + 1
  });

  it("persists to disk and survives re-initialization", async () => {
    store.add({ type: "file", description: "persist", content: "data",
      source: { kind: "ingested", path: "/persist" } });
    await store.flush();

    const store2 = new ExternalStore(tmpDir);
    await store2.initialize();
    expect(store2.getFullIndex().objects).toHaveLength(1);
    expect(store2.get(store2.getFullIndex().objects[0].id)?.content).toBe("data");
  });

  it("rebuildExternalizedMap() populates fingerprint→objectId mapping", () => {
    store.add({ type: "conversation", description: "msg", content: "hello",
      source: { kind: "externalized", fingerprint: "user:1234567890" } });
    store.rebuildExternalizedMap();
    // Verify via the store's internal map (exposed for testing)
    expect(store.getExternalizedObjectId("user:1234567890")).toBeDefined();
  });

  it("survives corrupt JSONL lines on rebuild", async () => {
    store.add({ type: "file", description: "good", content: "ok",
      source: { kind: "ingested", path: "/good" } });
    await store.flush();
    // Append a corrupt line
    await fs.promises.appendFile(
      path.join(tmpDir, "store.jsonl"), "\n{broken json\n"
    );
    // Delete index to force rebuild from JSONL
    await fs.promises.unlink(path.join(tmpDir, "index.json"));

    const store2 = new ExternalStore(tmpDir);
    await store2.initialize();
    expect(store2.getFullIndex().objects).toHaveLength(1); // Good line survives
  });
});
```

**`tests/unit/fingerprint.test.ts`** — Phase 1

```typescript
describe("messageFingerprint", () => {
  it("uses role:timestamp for UserMessage", () => {
    const msg = userMsg("hello", 1700000000000);
    expect(messageFingerprint(msg)).toBe("user:1700000000000");
  });

  it("uses role:timestamp for AssistantMessage", () => {
    const msg = assistantMsg("world", 1700000000001);
    expect(messageFingerprint(msg)).toBe("assistant:1700000000001");
  });

  it("uses toolResult:toolCallId for ToolResultMessage", () => {
    const msg = toolResultMsg("bash", "output", "call_abc123");
    expect(messageFingerprint(msg)).toBe("toolResult:call_abc123");
  });

  it("is stable across calls for the same message", () => {
    const msg = userMsg("hello", 12345);
    expect(messageFingerprint(msg)).toBe(messageFingerprint(msg));
  });

  it("is unique for messages with different timestamps", () => {
    const a = userMsg("hello", 1);
    const b = userMsg("hello", 2);
    expect(messageFingerprint(a)).not.toBe(messageFingerprint(b));
  });
});
```

**`tests/unit/call-tree.test.ts`** — Phase 2

```typescript
describe("CallTree", () => {
  it("registerOperation returns an AbortController", () => {
    const tree = new CallTree(50);
    const controller = tree.registerOperation("op-1", 0.01);
    expect(controller).toBeInstanceOf(AbortController);
    expect(controller.signal.aborted).toBe(false);
  });

  it("abortAll() aborts all registered operations", () => {
    const tree = new CallTree(50);
    const c1 = tree.registerOperation("op-1", 0);
    const c2 = tree.registerOperation("op-2", 0);
    tree.abortAll();
    expect(c1.signal.aborted).toBe(true);
    expect(c2.signal.aborted).toBe(true);
  });

  it("incrementChildCalls returns false when budget exceeded", () => {
    const tree = new CallTree(3); // maxChildCalls = 3
    tree.registerOperation("op-1", 0);
    expect(tree.incrementChildCalls("op-1")).toBe(true);  // 1
    expect(tree.incrementChildCalls("op-1")).toBe(true);  // 2
    expect(tree.incrementChildCalls("op-1")).toBe(true);  // 3
    expect(tree.incrementChildCalls("op-1")).toBe(false); // 4 > 3
  });

  it("per-operation budget is independent across operations", () => {
    const tree = new CallTree(2);
    tree.registerOperation("op-1", 0);
    tree.registerOperation("op-2", 0);
    expect(tree.incrementChildCalls("op-1")).toBe(true);
    expect(tree.incrementChildCalls("op-1")).toBe(true);
    expect(tree.incrementChildCalls("op-1")).toBe(false); // op-1 exhausted
    expect(tree.incrementChildCalls("op-2")).toBe(true);  // op-2 independent
  });

  it("completeOperation removes the operation", () => {
    const tree = new CallTree(50);
    tree.registerOperation("op-1", 0);
    tree.completeOperation("op-1");
    expect(tree.incrementChildCalls("op-1")).toBe(false); // op gone
  });
});
```

### 14.5 Component Test Specifications

Component tests wire together multiple modules with mocked Pi APIs.

**`tests/component/context-handler.test.ts`** — Phase 1

```typescript
describe("context event handler", () => {
  let state: RlmState;
  let ctx: ExtensionContext;

  beforeEach(async () => {
    state = await createTestState(); // Initializes store, manifest, etc. in tmpDir
    ctx = mockCtx({ tokens: 130_000, contextWindow: 200_000 }); // 65% — above 60% threshold
  });

  it("replaces already-externalized messages with stubs", async () => {
    // Pre-externalize a message
    const msg = userMsg("original content", 1000);
    state.store.add({
      type: "conversation", description: "user msg", content: "original content",
      source: { kind: "externalized", fingerprint: messageFingerprint(msg) },
    });
    state.store.rebuildExternalizedMap();

    const messages = [msg, userMsg("current question", 2000)];
    const result = await onContext({ type: "context", messages }, ctx);

    // First message should be stubbed
    const firstContent = result!.messages![1].content[0].text; // [0] is manifest
    expect(firstContent).toContain("[RLM externalized:");
    // Second message (most recent) should NOT be stubbed
    expect(result!.messages![2].content[0].text).toBe("current question");
  });

  it("externalizes when above tokenBudgetPercent threshold", async () => {
    const messages = [
      largeToolResult(100_000),    // ~25K tokens — this should get externalized
      userMsg("keep this", 9999),
    ];
    const result = await onContext({ type: "context", messages }, ctx);

    // Store should now have an object
    expect(state.store.getFullIndex().objects).toHaveLength(1);
    // The large message should be stubbed in the returned messages
    const stubbed = result!.messages!.find(m =>
      typeof m.content !== "string" && m.content[0]?.text?.includes("[RLM externalized:")
    );
    expect(stubbed).toBeDefined();
  });

  it("never externalizes the most recent user or assistant message", async () => {
    const messages = [
      largeToolResult(50_000),
      assistantMsg("recent response", 8888),
      userMsg("recent question", 9999),
    ];
    const result = await onContext({ type: "context", messages }, ctx);

    // The assistant and user messages should survive untouched
    const texts = result!.messages!
      .filter(m => m.role !== "user" || !m.content[0]?.text?.includes("RLM External"))
      .map(m => m.content[0]?.text);
    expect(texts).toContain("recent response");
    expect(texts).toContain("recent question");
  });

  it("injects manifest when store has objects", async () => {
    state.store.add({ type: "file", description: "test.ts", content: "code",
      source: { kind: "ingested", path: "/test.ts" } });

    const messages = [userMsg("hello")];
    const result = await onContext({ type: "context", messages }, ctx);

    expect(result!.messages![0].role).toBe("user");
    expect(result!.messages![0].content[0].text).toContain("RLM External Context");
  });

  it("skips externalization when tokens are null", async () => {
    ctx = mockCtx({ tokens: null });
    state.store.add({ type: "file", description: "existing", content: "data",
      source: { kind: "externalized", fingerprint: "user:1000" } });
    state.store.rebuildExternalizedMap();

    const messages = [userMsg("hello", 1000), userMsg("world", 2000)];
    const result = await onContext({ type: "context", messages }, ctx);

    // Should still replace existing stubs and inject manifest
    // but should NOT externalize new content
    expect(state.store.getFullIndex().objects).toHaveLength(1); // No new objects
  });

  it("warm content is not re-externalized", async () => {
    const msg = toolResultMsg("bash", "some output", "call_warm");
    state.store.add({ type: "tool_output", description: "bash output",
      content: "some output",
      source: { kind: "externalized", fingerprint: messageFingerprint(msg) } });
    state.store.rebuildExternalizedMap();
    const objId = state.store.getExternalizedObjectId(messageFingerprint(msg))!;
    state.warmTracker.markWarm([objId]); // Mark as warm

    // The message appears in context (Pi restored it from session)
    // but since it's warm, it should get its stub but not be re-externalized
    // (it's already externalized — warm just prevents re-processing the same msg)
    const messages = [msg, userMsg("question")];
    const result = await onContext({ type: "context", messages }, ctx);

    // Stub should still be applied (it's externalized)
    const content = result!.messages![1].content[0].text;
    expect(content).toContain("[RLM externalized:");
  });
});
```

**`tests/component/tools-peek.test.ts`** — Phase 1

```typescript
describe("rlm_peek tool", () => {
  it("returns a slice of the object content", async () => {
    const tool = state.tools.get("rlm_peek")!;
    const obj = state.store.add({ type: "file", description: "big",
      content: "ABCDEFGHIJ", source: { kind: "ingested", path: "/big" } });

    const result = await tool.execute("tc1", { id: obj.id, offset: 2, length: 5 },
      undefined, undefined, ctx);

    expect(result.content[0].text).toBe("CDEFG");
  });

  it("indicates continuation when content remains", async () => {
    const tool = state.tools.get("rlm_peek")!;
    const obj = state.store.add({ type: "file", description: "big",
      content: "A".repeat(5000), source: { kind: "ingested", path: "/big" } });

    const result = await tool.execute("tc1", { id: obj.id, offset: 0, length: 100 },
      undefined, undefined, ctx);

    expect(result.content[0].text).toContain("Use offset=100 to continue");
  });

  it("returns error when RLM is disabled", async () => {
    state.enabled = false;
    const tool = state.tools.get("rlm_peek")!;
    const result = await tool.execute("tc1", { id: "any", offset: 0, length: 100 },
      undefined, undefined, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("RLM is disabled");
  });

  it("returns error for nonexistent object ID", async () => {
    const tool = state.tools.get("rlm_peek")!;
    const result = await tool.execute("tc1", { id: "rlm-obj-nope", offset: 0, length: 100 },
      undefined, undefined, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });
});
```

### 14.6 E2E Tests — Real Pi, Real Models, Real Scenarios

E2E tests are a **development tool**. You run them locally, while you're
building, to know whether what you just wrote actually works with a real model
before you ever push. They are the primary quality gate — not CI, not code
review, not manual testing. If the E2E scenarios don't pass on your machine,
you're not done.

**Test harness:** All E2E tests use Pi's **RPC mode**
(`pi --mode rpc -e ./src/index.ts --no-session`) for programmatic control.
The harness sends prompts via stdin JSON and reads events from stdout JSON lines.

**Assertion style:** E2E tests use **behavioral assertions** — did the model
call the right tool? did the answer contain the expected fact? did compaction
fire? They do NOT assert exact strings (models are non-deterministic). Each
test gets 1 automatic retry to handle model non-determinism.

```typescript
// tests/helpers/pi-harness.ts
import { spawn, ChildProcess } from "node:child_process";
import * as readline from "node:readline";

export class PiHarness {
  private proc: ChildProcess;
  private rl: readline.Interface;
  private events: any[] = [];
  private pendingResolvers: Array<(event: any) => void> = [];

  static async start(extensionPath: string, opts?: {
    cwd?: string;
  }): Promise<PiHarness> {
    const harness = new PiHarness(extensionPath, opts);
    await harness.waitForReady();
    return harness;
  }

  private constructor(extensionPath: string, opts?: { cwd?: string }) {
    this.proc = spawn("pi", [
      "--mode", "rpc",
      "-e", extensionPath,
      "--no-session",
    ], { cwd: opts?.cwd ?? "/tmp/pi-rlm-test" });

    this.rl = readline.createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line) => {
      try {
        const event = JSON.parse(line);
        this.events.push(event);
        for (let i = this.pendingResolvers.length - 1; i >= 0; i--) {
          this.pendingResolvers[i](event);
        }
      } catch { /* ignore non-JSON lines */ }
    });
  }

  /** Send a command to Pi via RPC. */
  send(cmd: Record<string, any>): void {
    this.proc.stdin!.write(JSON.stringify(cmd) + "\n");
  }

  /** Send a prompt and wait for agent_end. Returns events from this run. */
  async prompt(text: string, timeoutMs = 120_000): Promise<any[]> {
    const startIdx = this.events.length;
    this.send({ type: "prompt", message: text });
    await this.waitFor("agent_end", timeoutMs);
    return this.events.slice(startIdx);
  }

  /** Steer (interrupt) with a new message during streaming. */
  steer(text: string): void {
    this.send({ type: "prompt", message: text, streamingBehavior: "steer" });
  }

  /** Wait for a specific event type. */
  async waitFor(type: string, timeoutMs = 60_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs
      );
      const check = (event: any) => {
        if (event.type === type) {
          clearTimeout(timer);
          this.pendingResolvers = this.pendingResolvers.filter(r => r !== check);
          resolve(event);
        }
      };
      const existing = this.events.find(e => e.type === type);
      if (existing) { clearTimeout(timer); resolve(existing); return; }
      this.pendingResolvers.push(check);
    });
  }

  /** Get all tool_execution_end events for a specific tool. */
  toolResults(toolName: string): any[] {
    return this.events.filter(e =>
      e.type === "tool_execution_end" && e.toolName === toolName
    );
  }

  /** Get all tool_execution_end events for any rlm_* tool. */
  rlmToolResults(): any[] {
    return this.events.filter(e =>
      e.type === "tool_execution_end" && e.toolName?.startsWith("rlm_")
    );
  }

  /** Count of auto_compaction_end events (should be 0 if RLM is working). */
  compactionCount(): number {
    return this.events.filter(e => e.type === "auto_compaction_end").length;
  }

  /** Extract text from the last assistant message in a set of events. */
  lastAssistantText(events?: any[]): string {
    const pool = events ?? this.events;
    const msgs = pool
      .filter(e => e.type === "message_end" && e.message?.role === "assistant")
      .map(e => e.message);
    const last = msgs.pop();
    return last?.content
      ?.filter((c: any) => c.type === "text")
      ?.map((c: any) => c.text)
      ?.join("") ?? "";
  }

  /** Reset event log (useful between scenarios in the same session). */
  clearEvents(): void { this.events = []; }

  async stop(): Promise<void> {
    this.proc.kill("SIGTERM");
    return new Promise(resolve => this.proc.on("exit", resolve));
  }
}
```

```typescript
// tests/helpers/assertions.ts

/** Assert the model called a specific tool at least once. */
export function expectToolUsed(events: any[], toolName: string): void {
  const calls = events.filter(e =>
    e.type === "tool_execution_end" && e.toolName === toolName
  );
  expect(calls.length, `Expected model to call ${toolName}`).toBeGreaterThan(0);
}

/** Assert the model did NOT call a specific tool. */
export function expectToolNotUsed(events: any[], toolName: string): void {
  const calls = events.filter(e =>
    e.type === "tool_execution_end" && e.toolName === toolName
  );
  expect(calls.length, `Expected model NOT to call ${toolName}`).toBe(0);
}

/** Assert the last assistant message contains a substring (case-insensitive). */
export function expectAnswerContains(pi: PiHarness, substring: string, events?: any[]): void {
  const text = pi.lastAssistantText(events);
  expect(text.toLowerCase()).toContain(substring.toLowerCase());
}

/** Assert the model gave an honest "not found" response (no confabulation). */
export function expectHonestMiss(pi: PiHarness, events?: any[]): void {
  const text = pi.lastAssistantText(events).toLowerCase();
  const honest =
    text.includes("don't") || text.includes("couldn't find") ||
    text.includes("no results") || text.includes("not found") ||
    text.includes("didn't read") || text.includes("no matching") ||
    text.includes("doesn't appear") || text.includes("not in");
  expect(honest, "Model should honestly report missing content, not confabulate").toBe(true);
}
```

Each E2E test file is a **scenario** — a coherent multi-turn story that
exercises one core RLM capability end-to-end with a real model. Every scenario
starts a fresh Pi session and tears it down afterward. Every scenario has
`{ retry: 1 }` to handle model non-determinism.

---

**Scenario 1: Long Session — Externalization + Retrieval**
(`tests/e2e/scenario-long-session.test.ts`)

The foundational scenario. Verifies the entire externalization → stub → manifest
→ retrieval pipeline works with a real model. This is the single most important
test — if it fails, the extension doesn't work.

```typescript
describe("Scenario: long session with externalization and retrieval", () => {
  let pi: PiHarness;

  beforeAll(async () => {
    pi = await PiHarness.start("./src/index.ts");
  }, 30_000);

  afterAll(() => pi.stop());

  it("reads a large file, externalizes it, then retrieves facts from it", async () => {
    // Turn 1: Read a large file — this generates a big tool output
    await pi.prompt("Read /etc/services and tell me how many lines it has");

    // Turns 2–6: Generate enough context to push past the externalization threshold
    for (let i = 0; i < 5; i++) {
      pi.clearEvents();
      await pi.prompt(
        `Read /etc/services from line ${i * 200 + 1} to ${(i + 1) * 200} and ` +
        `list any services on port 80-100 in that range`
      );
    }

    // Turn 7: Ask about the original content — model must retrieve from store
    pi.clearEvents();
    const events = await pi.prompt(
      "What port does the 'http' service use according to /etc/services?"
    );

    // Model MUST use an RLM tool to answer (content was externalized)
    const rlmCalls = events.filter(e =>
      e.type === "tool_execution_end" && e.toolName?.startsWith("rlm_")
    );
    expect(rlmCalls.length, "Model must use RLM tools to retrieve externalized content")
      .toBeGreaterThan(0);

    // Model MUST get the right answer
    expectAnswerContains(pi, "80", events);
  }, 300_000);

  it("never triggers auto-compaction", () => {
    // After all those turns, compaction should NOT have fired
    expect(pi.compactionCount()).toBe(0);
  });
}, { retry: 1 });
```

---

**Scenario 2: Cross-Turn Retrieval**
(`tests/e2e/scenario-cross-turn-retrieval.test.ts`)

Tests that the model can recall content from much earlier in the conversation
after it has been externalized, and that the manifest guides retrieval.

```typescript
describe("Scenario: cross-turn retrieval", () => {
  let pi: PiHarness;

  beforeAll(async () => {
    pi = await PiHarness.start("./src/index.ts");
  }, 30_000);

  afterAll(() => pi.stop());

  it("retrieves content discussed 10+ turns ago", async () => {
    // Turn 1: Discuss a specific topic
    await pi.prompt("Read /etc/hosts and explain every entry");

    // Turns 2–10: Build up lots of unrelated context to force externalization
    for (let i = 0; i < 9; i++) {
      await pi.prompt(
        `Read /etc/services from line ${i * 100 + 1} to ${(i + 1) * 100} ` +
        `and count TCP vs UDP entries`
      );
    }

    // Turn 11: Ask about the /etc/hosts content from turn 1
    pi.clearEvents();
    const events = await pi.prompt(
      "Remember when you read /etc/hosts at the start? " +
      "What was the IP address for localhost?"
    );

    // CRITICAL: Model must search external store — not say "I don't have it"
    expectToolUsed(events, "rlm_search");
    expectAnswerContains(pi, "127.0.0.1", events);
  }, 600_000);

  it("manifest lists the hosts file object", async () => {
    pi.clearEvents();
    const events = await pi.prompt(
      "What objects are in your RLM external store? List them."
    );

    // Model should reference the manifest and mention the hosts file
    const text = pi.lastAssistantText(events).toLowerCase();
    expect(text).toContain("hosts");
    expect(text).toContain("rlm-obj-");
  }, 60_000);
}, { retry: 1 });
```

---

**Scenario 3: Ingest + Analyze a Codebase**
(`tests/e2e/scenario-ingest-and-analyze.test.ts`)

Tests the whole `rlm_ingest` → `rlm_query`/`rlm_batch` pipeline — the model
ingests files, then performs analysis over externalized objects.

```typescript
describe("Scenario: ingest and analyze", () => {
  let pi: PiHarness;
  let testDir: string;

  beforeAll(async () => {
    // Create a small test project to ingest
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rlm-e2e-"));
    await fs.promises.writeFile(path.join(testDir, "math.ts"),
      `export function add(a: number, b: number): number { return a + b; }\n` +
      `export function multiply(a: number, b: number): number { return a * b; }\n`
    );
    await fs.promises.writeFile(path.join(testDir, "string.ts"),
      `export function capitalize(s: string): string { return s[0].toUpperCase() + s.slice(1); }\n` +
      `export function reverse(s: string): string { return s.split("").reverse().join(""); }\n`
    );
    await fs.promises.writeFile(path.join(testDir, "index.ts"),
      `export { add, multiply } from "./math";\n` +
      `export { capitalize, reverse } from "./string";\n`
    );

    pi = await PiHarness.start("./src/index.ts", { cwd: testDir });
  }, 30_000);

  afterAll(async () => {
    await pi.stop();
    await fs.promises.rm(testDir, { recursive: true });
  });

  it("ingests files and can query across them", async () => {
    // Step 1: Ingest the project
    const ingestEvents = await pi.prompt(
      `Use rlm_ingest to ingest all .ts files in ${testDir}`
    );
    expectToolUsed(ingestEvents, "rlm_ingest");

    // Step 2: Ask an analytical question that spans files
    pi.clearEvents();
    const queryEvents = await pi.prompt(
      "Using the RLM store, list all exported functions across all files " +
      "and categorize them by their parameter types"
    );

    // Model should use rlm_query or rlm_peek + rlm_search to answer
    const rlmCalls = queryEvents.filter(e =>
      e.type === "tool_execution_end" && e.toolName?.startsWith("rlm_")
    );
    expect(rlmCalls.length).toBeGreaterThan(0);

    // Answer should reference all functions
    const text = pi.lastAssistantText(queryEvents).toLowerCase();
    expect(text).toContain("add");
    expect(text).toContain("multiply");
    expect(text).toContain("capitalize");
    expect(text).toContain("reverse");
  }, 180_000);

  it("batch analysis works over ingested objects", async () => {
    pi.clearEvents();
    const batchEvents = await pi.prompt(
      "Use rlm_batch to analyze each ingested file and generate a one-line " +
      "summary of what it exports"
    );
    expectToolUsed(batchEvents, "rlm_batch");

    // Batch should have processed multiple objects
    const batchResults = batchEvents.filter(e =>
      e.type === "tool_execution_end" && e.toolName === "rlm_batch"
    );
    expect(batchResults.length).toBeGreaterThan(0);
  }, 180_000);
}, { retry: 1 });
```

---

**Scenario 4: Session Resume**
(`tests/e2e/scenario-session-resume.test.ts`)

Tests that externalized content survives session boundaries — the store
persists and is available when a new session starts in the same project.

```typescript
describe("Scenario: session resume", () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rlm-resume-"));
  });

  afterAll(async () => {
    await fs.promises.rm(testDir, { recursive: true });
  });

  it("store content survives across sessions", async () => {
    // Session 1: Ingest some content
    const pi1 = await PiHarness.start("./src/index.ts", { cwd: testDir });
    await pi1.prompt("Use rlm_ingest to ingest /etc/hosts");
    expectToolUsed(pi1.events, "rlm_ingest");
    await pi1.stop();

    // Session 2: Verify the content is still accessible
    const pi2 = await PiHarness.start("./src/index.ts", { cwd: testDir });
    const events = await pi2.prompt(
      "Search the RLM store for 'localhost'"
    );
    expectToolUsed(events, "rlm_search");

    // The search should find the content from session 1
    const searchResults = events.filter(e =>
      e.type === "tool_execution_end" && e.toolName === "rlm_search" && !e.isError
    );
    expect(searchResults.length).toBeGreaterThan(0);

    const resultText = searchResults[0]?.result?.content?.[0]?.text ?? "";
    expect(resultText.toLowerCase()).toContain("localhost");

    await pi2.stop();
  }, 120_000);
}, { retry: 1 });
```

---

**Scenario 5: Cancel Mid-Operation**
(`tests/e2e/scenario-cancel-mid-operation.test.ts`)

Tests that `/rlm cancel` aborts in-flight recursive calls without disabling
the extension, and that the extension continues to work afterward.

```typescript
describe("Scenario: cancel mid-operation", () => {
  let pi: PiHarness;

  beforeAll(async () => {
    pi = await PiHarness.start("./src/index.ts");
  }, 30_000);

  afterAll(() => pi.stop());

  it("/rlm cancel aborts operations but leaves RLM enabled", async () => {
    // Start a long operation
    pi.send({ type: "prompt", message:
      "Use rlm_ingest to ingest /etc/services then use rlm_batch to " +
      "analyze every object in the store" });

    // Wait for first tool to start
    await pi.waitFor("tool_execution_start", 30_000);

    // Cancel
    pi.steer("/rlm cancel");
    await pi.waitFor("agent_end", 60_000);

    // Verify: RLM is still on — we can still use tools
    pi.clearEvents();
    const events = await pi.prompt("Use rlm_search to search for 'http'");
    expectToolUsed(events, "rlm_search");
  }, 180_000);
}, { retry: 1 });
```

---

**Scenario 6: Disable / Enable**
(`tests/e2e/scenario-disable-enable.test.ts`)

Tests the full on→off→on lifecycle. When off, RLM tools should return
errors. When re-enabled, everything should work again.

```typescript
describe("Scenario: disable and re-enable", () => {
  let pi: PiHarness;

  beforeAll(async () => {
    pi = await PiHarness.start("./src/index.ts");
  }, 30_000);

  afterAll(() => pi.stop());

  it("tools return errors when disabled, work when re-enabled", async () => {
    // Step 1: Ingest content while enabled
    await pi.prompt("Use rlm_ingest to ingest /etc/hosts");
    expectToolUsed(pi.events, "rlm_ingest");

    // Step 2: Disable
    pi.clearEvents();
    await pi.prompt("/rlm off");

    // Step 3: Try to use RLM tool — should fail gracefully
    pi.clearEvents();
    const offEvents = await pi.prompt("Use rlm_search to search for localhost");
    const searchResults = offEvents.filter(e =>
      e.type === "tool_execution_end" && e.toolName === "rlm_search"
    );
    // If model calls the tool, it should get an error
    if (searchResults.length > 0) {
      expect(searchResults[0].isError).toBe(true);
    }

    // Step 4: Re-enable
    pi.clearEvents();
    await pi.prompt("/rlm on");

    // Step 5: Tool should work again
    pi.clearEvents();
    const onEvents = await pi.prompt("Use rlm_search to search for localhost");
    expectToolUsed(onEvents, "rlm_search");
    const okResults = onEvents.filter(e =>
      e.type === "tool_execution_end" && e.toolName === "rlm_search" && !e.isError
    );
    expect(okResults.length).toBeGreaterThan(0);
  }, 180_000);
}, { retry: 1 });
```

---

**Scenario 7: No Confabulation**
(`tests/e2e/scenario-no-confabulation.test.ts`)

The hardest test for the LLM. Verifies the model doesn't make up content when
the external store has no matching results. This is a critical trust property.

```typescript
describe("Scenario: no confabulation on missing content", () => {
  let pi: PiHarness;

  beforeAll(async () => {
    pi = await PiHarness.start("./src/index.ts");
    // Build up a store with known content
    await pi.prompt("Read /etc/hosts and explain it");
    for (let i = 0; i < 5; i++) {
      await pi.prompt(`Read /etc/services lines ${i*200+1} to ${(i+1)*200}`);
    }
  }, 180_000);

  afterAll(() => pi.stop());

  it("honestly reports when asked about content never ingested", async () => {
    pi.clearEvents();
    const events = await pi.prompt(
      "What was in the file /etc/imaginary-config.yml that you read earlier?"
    );

    // Model should search, find nothing, and say so
    expectHonestMiss(pi, events);
  }, 60_000);

  it("doesn't invent file contents for a real path not in the store", async () => {
    pi.clearEvents();
    const events = await pi.prompt(
      "Earlier you read /etc/shadow and showed me the passwords. " +
      "Can you show them again?"
    );

    // Model must NOT play along with the false premise
    expectHonestMiss(pi, events);
  }, 60_000);

  it("retrieves real content correctly to prove it's not just always refusing", async () => {
    pi.clearEvents();
    const events = await pi.prompt(
      "Show me the contents of /etc/hosts from the external store"
    );

    // For content that DOES exist, model should retrieve it
    expectToolUsed(events, "rlm_search");
    expectAnswerContains(pi, "localhost", events);
  }, 60_000);
}, { retry: 1 });
```

### 14.7 Test Phasing

Each phase adds tests for its deliverables. Tests from earlier phases
continue to run (regression). **No phase is complete until the developer has
run its E2E scenarios locally and they pass with a real model.**

| Phase | Unit tests | Component tests | E2E scenarios |
|-------|-----------|----------------|---------------|
| 1 | store, fingerprint, manifest, tokens, write-queue | externalizer, context-handler, tools-peek, tools-search, commands, compaction-intercept | **long-session**, **cross-turn-retrieval**, **session-resume** |
| 2 | call-tree, concurrency, cost-estimator | tools-query, tools-batch, tools-ingest | **ingest-and-analyze**, **cancel-mid-operation** |
| 3 | warm-tracker, regex-timeout, retry | (hardening of existing) | **disable-enable**, **no-confabulation** |
| 4 | — | widget | (all scenarios re-run as regression) |

### 14.8 Coverage Targets and CI

**Coverage targets (V8 provider):**

| Module | Line coverage | Branch coverage | Notes |
|--------|-------------|----------------|-------|
| `src/store/` | 90% | 85% | Core data path — high coverage essential |
| `src/context/` | 85% | 80% | Externalization logic, many branches |
| `src/engine/` | 80% | 75% | Async/concurrent — harder to cover all paths |
| `src/tools/` | 85% | 80% | Each tool's happy + error paths |
| `src/ui/` | 50% | — | Manual TUI testing, not automated |
| **Overall** | **80%** | **75%** | |

**Development workflow:**

E2E tests are the primary development loop for verifying RLM works. You run
them locally after every meaningful change. They are not a CI step — they're
how you know you're done.

```bash
# After implementing or changing anything in src/:

# 1. Fast gate — unit + component tests catch regressions (seconds)
npx vitest run tests/unit tests/component

# 2. Run the E2E scenario for what you just changed
npx vitest run tests/e2e/scenario-long-session.test.ts --timeout 300000

# 3. Before considering a feature complete — run ALL E2E scenarios
npx vitest run tests/e2e --timeout 600000 --retry 1

# 4. Full suite (unit + component + e2e) — the "am I done?" command
npx vitest run

# During active development — unit + component in watch mode
npx vitest tests/unit tests/component
```

**Which scenario to run when:**

| You just changed... | Run this scenario |
|--------------------|-------------------|
| Store, fingerprint, externalization | `scenario-long-session` |
| Context handler, manifest injection | `scenario-cross-turn-retrieval` |
| `rlm_ingest`, `rlm_query`, `rlm_batch` | `scenario-ingest-and-analyze` |
| Store persistence, initialization | `scenario-session-resume` |
| CallTree, abort, `/rlm cancel` | `scenario-cancel-mid-operation` |
| Disabled guard, `/rlm on`/`off` | `scenario-disable-enable` |
| System prompt, tool descriptions | `scenario-no-confabulation` |

**CI (GitHub Actions):**

CI runs unit + component tests as a fast sanity check on push. E2E tests are
the developer's responsibility to run locally before pushing — they require a
configured Pi agent with model providers which CI runners don't have.

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npx vitest run tests/unit tests/component --coverage
      - uses: actions/upload-artifact@v4
        with: { name: coverage, path: coverage/ }
```

---

## References

- [Pi-RLM Vision](vision.md)
- [Pi-RLM Requirements](requirements.md)
- [Pi Extension API](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- Zhang, A. L., Wei, D., Jang, L., & Madry, A. (2025). *Recursive Language
  Models.* MIT CSAIL. [arXiv:2512.24601](https://arxiv.org/abs/2512.24601)
