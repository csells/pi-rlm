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
2. [Component Architecture](#2-component-architecture)
3. [Data Schemas](#3-data-schemas)
4. [Event Handler Flow](#4-event-handler-flow)
5. [Context Externalization Algorithm](#5-context-externalization-algorithm)
6. [Recursive Call Engine](#6-recursive-call-engine)
7. [Tool Implementations](#7-tool-implementations)
8. [Command Implementations](#8-command-implementations)
9. [System Prompt Template](#9-system-prompt-template)
10. [Widget Rendering](#10-widget-rendering)
11. [Configuration and Persistence](#11-configuration-and-persistence)
12. [Error Handling Strategy](#12-error-handling-strategy)
13. [Implementation Phases](#13-implementation-phases)

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
  callTree: CallTree;             // Active operation tracking
  costEstimator: CostEstimator;   // Cost estimation from model metadata
  trajectory: TrajectoryLogger;   // JSONL trajectory writer
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
  | { kind: "externalized"; messageId: string }      // From context externalization
  | { kind: "ingested"; path: string }               // From rlm_ingest
  | { kind: "extracted"; sourceId: string }           // From rlm_extract
  | { kind: "child_result"; callId: string };         // From recursive call
```

**Note:** Externalization source uses `messageId` (stable string identifier),
not a positional index. This enables reliable reconstruction of the
`externalizedMessages` map on restart — iterate store records, filter by
`source.kind === "externalized"`, and rebuild `messageId → objectId` mapping.

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
prepended as a system-role message at the start of the messages array.

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

Each line in `.pi/rlm/<session-id>/trajectory.jsonl`:

```typescript
interface TrajectoryRecord {
  callId: string;                 // Unique call identifier
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
```

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

**Tool availability when disabled (FR-9.2):** Tools are always registered
(Pi's extension API does not support dynamic deregistration). Each tool's
`execute()` method starts with `disabledGuard(state)` which returns an error
result if `!state.enabled`:

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

  // 4. Rebuild externalizedMessages map from store
  state.store.rebuildExternalizedMap();  // Scans records with source.kind === "externalized"

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
  const usage = ctx.getContextUsage();
  if (usage) {
    const model = ctx.model;
    const windowSize = model.contextWindow;
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
    objectId = externalizedMessages.get(message.id)
    if objectId and warmTracker.isWarm(objectId) → skip (FR-3.9)

    if message has tool results with large output → prioritize (FR-3.5)
    candidates.push({ message, estimatedTokens })

  sort candidates by estimatedTokens descending (largest first)

  for each candidate:
    if countMessageTokens(messages) <= threshold → break

    object = store.add({
      type: inferContentType(candidate.message),
      description: generateDescription(candidate.message),
      content: extractContent(candidate.message),
      source: { kind: "externalized", messageId: candidate.message.id },
    })

    externalizedMessages.set(candidate.message.id, object.id)
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
      object = store.add({
        ...,
        source: { kind: "externalized", messageId: message.id },
      })
      externalizedMessages.set(message.id, object.id)
      replaceWithStub(messages, message, object)
```

### 5.4 Stub Replacement for Already-Externalized Content

On subsequent LLM calls, content that was previously externalized will exist
in the session history (because the user's view is unchanged) but should be
stubbed in the LLM's copy.

```typescript
// In-memory tracking — rebuilt from store on session_start (§4.2, step 4)
const externalizedMessages = new Map<string, string>();  // messageId → storeObjectId

function replaceExternalizedWithStubs(messages: Message[], store: ExternalStore) {
  for (const msg of messages) {
    const objId = externalizedMessages.get(msg.id);
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
populates `externalizedMessages` from `source.messageId → record.id`. This
works because message IDs are stable across restarts (they're stored in Pi's
session file).

### 5.5 Description Generation

For the manifest, each externalized object needs a brief description. This is
generated locally (no LLM call) based on content type:

| Content Type | Description Strategy |
|---|---|
| `file` | Path from tool args, e.g., "src/auth.ts (full file)" |
| `tool_output` | Tool name + first line, e.g., "bash: npm test — 47 lines" |
| `conversation` | Role + first 80 chars, e.g., "User: Can you check the race condition in…" |
| `artifact` | Label from rlm_extract instructions, e.g., "Extracted: auth module API surface" |

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
    operationSignal: AbortSignal,
    ctx: ExtensionContext,
    modelOverride?: string,       // Per-call model override
  ): Promise<ChildCallResult> { ... }

  async batch(
    instructions: string,
    targetIds: string[],
    parentCallId: string | null,
    depth: number,
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
): Model {
  const modelStr = modelOverride ?? config.childModel;
  if (modelStr) {
    const [provider, ...idParts] = modelStr.split("/");
    const id = idParts.join("/");
    const found = ctx.modelRegistry.find(provider, id);
    if (found) return found;
    // Fall back to root model if override not found
    console.warn(`[pi-rlm] Child model "${modelStr}" not found, using root model`);
  }
  return ctx.model;  // Same as root
}
```

### 6.3 Single Child Call Flow (`query`)

```
RecursiveEngine.query(instructions, targetIds, parentId, depth, signal, ctx, modelOverride):
  1. Check depth <= config.maxDepth. If exceeded, return error result.
  2. Check callTree.totalCalls < config.maxChildCalls. If exceeded:
     signal.abort() to cancel siblings, return budget-exceeded result.
  3. Atomically increment callTree.totalCalls.
  4. Generate callId = "rlm-call-" + crypto.randomUUID().slice(0,8)
  5. Register call in callTree (id, parentId, depth, status: "running")

  6. Resolve child model via resolveChildModel(modelOverride, config, ctx)

  7. Build child context:
     systemPrompt = buildChildSystemPrompt(instructions, depth, config)
     targetContent = targetIds.map(id => store.get(id).content).join("\n---\n")
     messages = [
       { role: "user", content: [{ type: "text", text: targetContent }] }
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
       response = await complete(model, { systemPrompt, messages, tools }, {
         signal: childController.signal,
         maxTokens: config.childMaxTokens,
       })
       // If child used tools, run the child agent loop (§6.5)
       result = parseChildResult(response.text)
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
  2. Register batch operation in callTree

  3. Create operation-level abort controller:
     opController = new AbortController()
     opTimeout = setTimeout(() => opController.abort(), config.operationTimeoutSec * 1000)
     const onAbort = () => opController.abort()
     signal.addEventListener("abort", onAbort, { once: true })

  4. Build task list:
     tasks = targetIds.map(id => ({
       targetId: id,
       instructions: instructions,
     }))

  5. Execute with concurrency limiter:
     limiter = new ConcurrencyLimiter(config.maxConcurrency)
     results = await limiter.map(tasks, async (task) => {
       // Budget check — abort ALL remaining if exceeded
       if (callTree.totalCalls >= config.maxChildCalls) {
         opController.abort()  // Cancel remaining children via shared signal
         return { answer: "Budget exceeded", confidence: "low", evidence: [] }
       }
       return await this.query(
         task.instructions, [task.targetId],
         operationId, depth, opController.signal, ctx, modelOverride
       )
     })

  6. clearTimeout(opTimeout)
     signal.removeEventListener("abort", onAbort)
  7. Return results (including partial results from completed children)
```

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
    const response = await complete(model, {
      systemPrompt: context.systemPrompt,
      messages,
      tools: context.tools,
    }, { signal, maxTokens });

    // If no tool calls, return the text response
    if (!response.toolCalls || response.toolCalls.length === 0) {
      return response.text;
    }

    // Execute tool calls and append results
    messages.push({ role: "assistant", content: response.content });
    for (const toolCall of response.toolCalls) {
      const handler = toolHandlers.get(toolCall.name);
      if (handler) {
        const result = await handler(toolCall.input);
        messages.push({
          role: "toolResult",
          toolCallId: toolCall.id,
          content: [{ type: "text", text: result }],
        });
      }
    }
    turns++;
  }

  // Max turns reached — return whatever we have
  return messages[messages.length - 1]?.content?.[0]?.text ?? "Max turns reached";
}
```

**Note on `complete()` vs `stream()`:** The design uses `complete()` from
`pi-ai`. If `complete()` is unavailable or returns differently than expected,
the fallback is to use `stream()` and collect the full response by consuming
the `AssistantMessageEventStream` to completion. The child agent loop handles
tool calls regardless of which function is used.

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
  private currentOpCost: number = 0;  // Accumulated during active operation

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
      (totalInputTokens * (model.cost?.input ?? 0)) +
      (config.childMaxTokens * (model.cost?.output ?? 0));

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
      (avgInputTokens * (model.cost?.input ?? 0)) +
      (config.childMaxTokens * (model.cost?.output ?? 0));

    return {
      estimatedCalls,
      estimatedCost: estimatedCalls * costPerCall,
    };
  }

  resetOperationCost() { this.currentOpCost = 0; }
  addCallCost(tokensIn: number, tokensOut: number, model: Model) {
    this.currentOpCost +=
      (tokensIn * (model.cost?.input ?? 0)) +
      (tokensOut * (model.cost?.output ?? 0));
  }
  getCurrentOperationCost(): number { return this.currentOpCost; }
}
```

---

## 7. Tool Implementations

All tools start with `disabledGuard(state)` and wrap their body in
`try/finally` to reset `state.phase`. All tools apply truncation to output
(FR-4.9).

### 7.1 `rlm_peek` (FR-4.1)

```typescript
pi.registerTool({
  name: "rlm_peek",
  label: "RLM Peek",
  description: "Retrieve a slice of an externalized object by ID and offset.",
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
async function searchWithWorkerTimeout(
  content: string, regex: RegExp, objectId: string, timeoutMs: number
): Promise<SearchMatch[]> {
  return new Promise((resolve) => {
    const worker = new Worker("./search-worker.ts", {
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
    state.costEstimator.resetOperationCost();
    updateWidget(ctx);

    // Operation timeout (FR-5.10)
    const opController = new AbortController();
    const opTimeout = setTimeout(() => opController.abort(), state.config.operationTimeoutSec * 1000);
    const onAbort = () => opController.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const result = await state.engine.query(
        params.instructions, targetIds, null, 0, opController.signal, ctx, params.model
      );

      const text = formatChildResult(result);
      const truncation = truncateHead(text, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      return {
        content: [{ type: "text", text: truncation.content }],
        details: { result },
      };
    } finally {
      clearTimeout(opTimeout);
      signal?.removeEventListener("abort", onAbort);
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
    state.costEstimator.resetOperationCost();
    updateWidget(ctx);

    const opController = new AbortController();
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
        text += `\n[Results truncated. ${results.length} objects processed.]`;
      }

      return {
        content: [{ type: "text", text }],
        details: { results },
      };
    } finally {
      clearTimeout(opTimeout);
      signal?.removeEventListener("abort", onAbort);
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
        ctx.ui.notify("RLM enabled. Context externalization is active.", "success");
        return;
      }

      if (subcommand === "off") {
        // Cancel any in-flight operations
        if (state.callTree.getActive().length > 0) {
          state.callTree.abortAll();
        }
        state.enabled = false;
        state.config.enabled = false;
        state.allowCompaction = false;  // Reset safety valve
        pi.appendEntry("rlm-config", state.config);
        updateWidget(ctx);
        ctx.ui.notify(
          "RLM disabled. Pi will use standard compaction. External store preserved on disk.",
          "info"
        );
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
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
```

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
    const budget = `${state.callTree.totalCalls}/${state.config.maxChildCalls}`;
    const cost = state.costEstimator.getCurrentOperationCost();
    const costStr = cost > 0 ? ` | $${cost.toFixed(4)}` : "";

    const lines = [
      theme.fg("warning", `RLM: ${state.phase}`) +
        theme.fg("muted", ` | depth: ${depth} | children: ${active.length} | budget: ${budget}${costStr}`),
    ];

    // FR-6.5: Token counts
    const usage = ctx.getContextUsage();
    if (usage) {
      lines.push(
        theme.fg("dim", `  context: ${usage.tokens.toLocaleString()} tokens | store: ${formatTokens(index.totalTokens)}`)
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

On `session_start`:
1. Check if disk store exists at `.pi/rlm/<session-id>/`
2. If yes: load `index.json`. If index is missing or corrupt, rebuild from
   `store.jsonl` by reading line-by-line.
3. If no: create directory, initialize empty store.

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

### 11.3 Store Cleanup (FR-1.8)

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
| `ctx.getContextUsage()` returns null | Skip externalization, still replace stubs |
| Model has no cost metadata | Use 0 for estimates, note "cost unknown" in widget |
| `complete()` unavailable | Fall back to `stream()` + collect full response |

---

## 13. Implementation Phases

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
10. `/rlm`, `/rlm on`, `/rlm off` commands
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

## References

- [Pi-RLM Vision](vision.md)
- [Pi-RLM Requirements](requirements.md)
- [Pi Extension API](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- Zhang, A. L., Wei, D., Jang, L., & Madry, A. (2025). *Recursive Language
  Models.* MIT CSAIL. [arXiv:2512.24601](https://arxiv.org/abs/2512.24601)
