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
8. [System Prompt Template](#8-system-prompt-template)
9. [Widget Rendering](#9-widget-rendering)
10. [Configuration and Persistence](#10-configuration-and-persistence)
11. [Error Handling Strategy](#11-error-handling-strategy)
12. [Implementation Phases](#12-implementation-phases)

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
│   │   └── warm-tracker.ts   # WarmTracker — tracks warm content (FR-3.9)
│   ├── engine/
│   │   ├── engine.ts         # RecursiveEngine — spawns/manages child calls
│   │   ├── call-tree.ts      # CallTree + CallNode — tracks active operations
│   │   ├── concurrency.ts    # ConcurrencyLimiter — Promise pool
│   │   └── cost.ts           # CostEstimator — uses model.cost metadata
│   ├── tools/
│   │   ├── peek.ts           # rlm_peek tool
│   │   ├── search.ts         # rlm_search tool (with regex timeout)
│   │   ├── query.ts          # rlm_query tool
│   │   ├── batch.ts          # rlm_batch tool
│   │   ├── ingest.ts         # rlm_ingest tool
│   │   ├── stats.ts          # rlm_stats tool
│   │   └── extract.ts        # rlm_extract tool (MAY)
│   ├── ui/
│   │   ├── widget.ts         # RlmWidget — persistent status widget
│   │   ├── inspector.ts      # InspectorOverlay — call tree visualizer
│   │   └── phases.ts         # Phase enum + labels
│   ├── commands.ts           # Slash command registrations
│   ├── system-prompt.ts      # System prompt injection template
│   ├── trajectory.ts         # TrajectoryLogger — JSONL trajectory writer
│   └── events.ts             # pi.events emission helpers
├── specs/                    # Vision, requirements, design (this file)
└── tests/                    # Unit tests (vitest)
    ├── store.test.ts
    ├── externalizer.test.ts
    ├── engine.test.ts
    └── manifest.test.ts
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
│  │    3. Initialize RecursiveEngine                          │   │
│  │    4. Register event handlers                             │   │
│  │    5. Register tools (if enabled)                         │   │
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
  warmTracker: WarmTracker;       // Tracks warm content
  engine: RecursiveEngine;        // Recursive call engine
  callTree: CallTree;             // Active operation tracking
  trajectory: TrajectoryLogger;   // JSONL trajectory writer
  phase: Phase;                   // Current processing phase
  sessionId: string;              // Current session identifier
  firstRun: boolean;              // First session_start after install
  turnCount: number;              // LLM call counter (for warm tracking)
}
```

### 2.2 Component Responsibilities

| Component | Responsibility | FR Coverage |
|-----------|---------------|-------------|
| `ExternalStore` | Persist/retrieve externalized content on disk | FR-1 |
| `ManifestBuilder` | Generate compact manifest for LLM context | FR-2 |
| `ContextExternalizer` | `context` event handler — stub replacement + externalization | FR-3 |
| `WarmTracker` | Track recently retrieved content, prevent re-externalization | FR-3.9 |
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
  | { kind: "externalized"; messageIndex: number }  // From context externalization
  | { kind: "ingested"; path: string }               // From rlm_ingest
  | { kind: "extracted"; sourceId: string }           // From rlm_extract
  | { kind: "child_result"; callId: string };         // From recursive call
```

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

The manifest is a text block injected at the end of the system prompt via
`before_agent_start`. Format:

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
          ├── pi.on("session_start", onSessionStart)
          ├── pi.on("before_agent_start", onBeforeAgentStart)
          ├── pi.on("context", onContext)
          ├── pi.on("session_before_compact", onBeforeCompact)
          ├── pi.on("session_before_switch", onBeforeSwitch)
          ├── pi.on("session_shutdown", onShutdown)
          ├── registerTools(pi, state)    // if enabled
          ├── registerCommands(pi, state)
          └── setupWidget(pi, state)
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
    if (entry.type === "custom" && entry.customType === "rlm-first-run") {
      state.firstRun = false;
    }
  }

  // 3. Initialize/reconstruct store from disk
  const storePath = path.join(ctx.cwd, ".pi", "rlm", state.sessionId);
  state.store = new ExternalStore(storePath);
  await state.store.initialize();  // Reads index.json, or rebuilds from store.jsonl

  // 4. Initialize trajectory logger
  state.trajectory = new TrajectoryLogger(storePath);

  // 5. First-run notification (FR-14.1)
  if (state.firstRun && ctx.hasUI) {
    ctx.ui.notify(
      "Pi-RLM is active. Use /rlm off to disable. Use /rlm for status.",
      "info"
    );
    pi.appendEntry("rlm-first-run", { shown: true });
    state.firstRun = false;
  }

  // 6. Update widget
  updateWidget(ctx);
}
```

### 4.3 `before_agent_start` Handler

Injects the RLM system prompt and context manifest.

```typescript
async function onBeforeAgentStart(event: any, ctx: ExtensionContext) {
  if (!state.enabled) return;

  const manifest = state.manifest.build(state.config.manifestBudget);
  const rlmPrompt = buildSystemPrompt(manifest, state.config);

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
  const usage = ctx.getContextUsage();
  if (!usage) return;

  const model = ctx.model;
  const windowSize = model.contextWindow;
  const threshold = windowSize * (state.config.tokenBudgetPercent / 100);
  const safetyThreshold = windowSize * (state.config.safetyValvePercent / 100);

  // Phase 1: Replace already-externalized content with stubs
  replaceExternalizedWithStubs(messages, state.store);

  // Phase 2: Check if externalization is needed
  if (usage.tokens > threshold) {
    state.phase = "externalizing";
    updateWidget(ctx);

    // Externalize oldest/largest non-warm content
    await externalize(messages, state, ctx);
  }

  // Phase 3: Safety valve (FR-3.8)
  const postUsage = estimateTokens(messages);
  if (postUsage > safetyThreshold) {
    await forceExternalize(messages, state, ctx);

    // If STILL over safety threshold, allow compaction
    const finalUsage = estimateTokens(messages);
    if (finalUsage > safetyThreshold) {
      state.allowCompaction = true;  // Checked in session_before_compact
    }
  }

  // Phase 4: Inject manifest into messages
  // (Manifest is in system prompt via before_agent_start, not message array)

  state.phase = "idle";
  updateWidget(ctx);

  return { messages };
}
```

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

  // Persist current config
  pi.appendEntry("rlm-config", state.config);
}
```

---

## 5. Context Externalization Algorithm

### 5.1 Normal Externalization (FR-3.2)

Called when context usage exceeds `tokenBudgetPercent`.

```
function externalize(messages, state, ctx):
  candidates = []
  for each message in messages (oldest first):
    if message is most recent user message → skip (FR-3.6)
    if message is most recent assistant message → skip (FR-3.6)
    if message.id is in warmTracker → skip (FR-3.9)
    if message has tool results with large output → prioritize (FR-3.5)
    candidates.push({ message, index, estimatedTokens })

  sort candidates by estimatedTokens descending (largest first)

  for each candidate:
    if estimateTokens(messages) <= threshold → break

    object = store.add({
      type: inferContentType(candidate.message),
      description: generateDescription(candidate.message),
      content: extractContent(candidate.message),
    })

    replaceWithStub(messages, candidate.index, object)
```

### 5.2 Force Externalization (FR-3.8)

Called when context exceeds `safetyValvePercent` after normal externalization.

```
function forceExternalize(messages, state, ctx):
  for each message in messages:
    if message is most recent user message → skip
    if message is most recent assistant message → skip
    if message is system prompt → skip

    if not already a stub:
      object = store.add(...)
      replaceWithStub(messages, index, object)
```

### 5.3 Stub Replacement for Already-Externalized Content

On subsequent LLM calls, content that was previously externalized will exist
in the session history (because the user's view is unchanged) but should be
stubbed in the LLM's copy. The context handler maintains a `Set<messageId>`
of externalized message indices and replaces them on every `context` event.

```typescript
// In-memory tracking — rebuilt from store on session_start
const externalizedMessages = new Map<string, string>();  // messageId → storeObjectId

function replaceExternalizedWithStubs(messages: Message[], store: ExternalStore) {
  for (const [msgId, objId] of externalizedMessages) {
    const msg = messages.find(m => m.id === msgId);
    if (msg) {
      const entry = store.getIndex(objId);
      if (entry) {
        replaceContentWithStub(msg, entry);
      }
    }
  }
}
```

### 5.4 Description Generation

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
  ): Promise<ChildCallResult> { ... }

  async batch(
    instructions: string,
    targetIds: string[],
    parentCallId: string | null,
    depth: number,
    operationSignal: AbortSignal,
    ctx: ExtensionContext,
  ): Promise<ChildCallResult[]> { ... }
}
```

### 6.2 Single Child Call Flow (`query`)

```
RecursiveEngine.query(instructions, targetIds, parentId, depth, signal, ctx):
  1. Check depth <= config.maxDepth. If exceeded, return error result.
  2. Check callTree.totalCalls < config.maxChildCalls. If exceeded, abort.
  3. Generate callId = "rlm-call-" + crypto.randomUUID().slice(0,8)
  4. Register call in callTree (id, parentId, depth, status: "running")

  5. Resolve child model:
     model = config.childModel
       ? ctx.modelRegistry.find(provider, id)
       : ctx.model  // Same as root

  6. Build child context:
     systemPrompt = buildChildSystemPrompt(instructions, depth, config)
     targetContent = targetIds.map(id => store.get(id).content).join("\n---\n")
     messages = [
       { role: "user", content: [{ type: "text", text: targetContent }] }
     ]

     // If depth < maxDepth, give child access to rlm_peek and rlm_search
     tools = depth < config.maxDepth
       ? [peekToolDef, searchToolDef, queryToolDef]
       : [peekToolDef, searchToolDef]  // No recursion at max depth

  7. Create child abort controller:
     childController = new AbortController()
     childTimeout = setTimeout(() => childController.abort(), config.childTimeoutSec * 1000)
     // Also abort if parent operation is cancelled
     operationSignal.addEventListener("abort", () => childController.abort())

  8. Execute child call:
     startTime = Date.now()
     try {
       response = await complete(model, { systemPrompt, messages, tools }, {
         signal: childController.signal,
         maxTokens: config.childMaxTokens,
       })
       // If child used tools (peek/search/query), run a simple agent loop:
       //   while response has tool_use, execute tools, append results, re-call
       result = parseChildResult(response.text)
       status = "success"
     } catch (err) {
       if (childController.signal.aborted) {
         result = { answer: "Timed out", confidence: "low", evidence: [] }
         status = "timeout"
       } else if (isRateLimitError(err)) {
         result = await retryWithBackoff(...)  // FR-5.11
         status = result ? "success" : "error"
       } else {
         result = { answer: err.message, confidence: "low", evidence: [] }
         status = "error"
       }
     } finally {
       clearTimeout(childTimeout)
     }

  9. Log to trajectory:
     trajectory.append({
       callId, parentCallId: parentId, depth, model: modelStr,
       query: instructions, targetIds, result,
       tokensIn, tokensOut,
       wallClockMs: Date.now() - startTime,
       status, timestamp: Date.now(),
     })

  10. Update callTree (status: completed/error/timeout)
  11. Mark retrieved content as warm (warmTracker.markWarm(targetIds))
  12. Return result
```

### 6.3 Batch Call Flow (`batch`)

```
RecursiveEngine.batch(instructions, targetIds, parentId, depth, signal, ctx):
  1. Generate operationId = "rlm-batch-" + crypto.randomUUID().slice(0,8)
  2. Register batch operation in callTree

  3. Create operation-level abort controller:
     opController = new AbortController()
     opTimeout = setTimeout(() => opController.abort(), config.operationTimeoutSec * 1000)
     signal.addEventListener("abort", () => opController.abort())

  4. Build task list:
     tasks = targetIds.map(id => ({
       targetId: id,
       instructions: instructions,
     }))

  5. Execute with concurrency limiter:
     limiter = new ConcurrencyLimiter(config.maxConcurrency)
     results = await limiter.map(tasks, async (task) => {
       // Check budget
       if (callTree.totalCalls >= config.maxChildCalls) {
         return { answer: "Budget exceeded", confidence: "low", evidence: [] }
       }
       return await this.query(
         task.instructions, [task.targetId],
         operationId, depth, opController.signal, ctx
       )
     })

  6. clearTimeout(opTimeout)
  7. Return results (including partial results from completed children)
```

### 6.4 Concurrency Limiter

```typescript
class ConcurrencyLimiter {
  constructor(private limit: number) {}

  async map<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < items.length) {
        const i = nextIndex++;
        results[i] = await fn(items[i]);
      }
    }

    const workers = Array.from(
      { length: Math.min(this.limit, items.length) },
      () => worker()
    );
    await Promise.all(workers);
    return results;
  }
}
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
  estimate(
    targetIds: string[],
    config: RlmConfig,
    model: Model,
  ): { estimatedCalls: number; estimatedCost: number } {
    const estimatedCalls = targetIds.length;  // One child per target
    const avgInputTokens = targetIds.reduce((sum, id) => {
      const entry = this.store.getIndex(id);
      return sum + (entry?.tokenEstimate ?? 0);
    }, 0) / estimatedCalls;

    const costPerCall =
      (avgInputTokens * (model.cost?.input ?? 0)) +
      (config.childMaxTokens * (model.cost?.output ?? 0));

    return {
      estimatedCalls,
      estimatedCost: estimatedCalls * costPerCall,
    };
  }
}
```

---

## 7. Tool Implementations

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
    const obj = state.store.get(params.id);
    if (!obj) return errorResult(`Object ${params.id} not found`);

    const slice = obj.content.slice(params.offset, params.offset + params.length);
    state.warmTracker.markWarm([params.id]);

    const truncated = truncateHead(slice, {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    });

    let text = truncated.content;
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
    const regex = parsePattern(params.pattern);  // Handles /regex/ or plain substring
    const objectIds = params.scope ?? state.store.getAllIds();
    const matches: SearchMatch[] = [];

    for (const id of objectIds) {
      const obj = state.store.get(id);
      if (!obj) continue;

      // Regex timeout (NFR-3.5): 5 seconds per object
      const objMatches = await searchWithTimeout(obj.content, regex, id, 5000);
      matches.push(...objMatches);

      if (matches.length >= 50) break;  // Cap results
    }

    state.warmTracker.markWarm(matches.map(m => m.objectId));

    const text = formatSearchResults(matches);
    const truncation = truncateHead(text, {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    });

    return { content: [{ type: "text", text: truncation.content }], details: {} };
  },
});
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
    const targetIds = Array.isArray(params.target) ? params.target : [params.target];

    // Cost check (FR-9.5)
    if (ctx.hasUI) {
      const estimate = state.costEstimator.estimate(targetIds, state.config, ctx.model);
      if (estimate.estimatedCalls > 10) {
        const ok = await ctx.ui.confirm(
          "RLM Query",
          `This will spawn ~${estimate.estimatedCalls} child calls (est. $${estimate.estimatedCost.toFixed(4)}). Proceed?`
        );
        if (!ok) return errorResult("Cancelled by user");
      }
    }

    state.phase = "querying";
    updateWidget(ctx);

    const opController = new AbortController();
    signal?.addEventListener("abort", () => opController.abort());

    const result = await state.engine.query(
      params.instructions, targetIds, null, 0, opController.signal, ctx
    );

    state.phase = "idle";
    updateWidget(ctx);

    return {
      content: [{ type: "text", text: formatChildResult(result) }],
      details: { result },
    };
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
    // Cost check
    if (ctx.hasUI) {
      const estimate = state.costEstimator.estimate(params.targets, state.config, ctx.model);
      if (estimate.estimatedCalls > 10) {
        const ok = await ctx.ui.confirm(
          "RLM Batch",
          `This will spawn ~${estimate.estimatedCalls} parallel calls (est. $${estimate.estimatedCost.toFixed(4)}). Proceed?`
        );
        if (!ok) return errorResult("Cancelled by user");
      }
    }

    state.phase = "batching";
    updateWidget(ctx);

    const opController = new AbortController();
    signal?.addEventListener("abort", () => opController.abort());

    const results = await state.engine.batch(
      params.instructions, params.targets, null, 0, opController.signal, ctx
    );

    state.phase = "synthesizing";
    updateWidget(ctx);

    // Synthesize results into summary
    const summary = results.map((r, i) => {
      const id = params.targets[i];
      return `### ${id}\n**Confidence:** ${r.confidence}\n${r.answer}`;
    }).join("\n\n");

    state.phase = "idle";
    updateWidget(ctx);

    const truncation = truncateHead(summary, {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    });

    return {
      content: [{ type: "text", text: truncation.content }],
      details: { results },
    };
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
    state.phase = "ingesting";
    updateWidget(ctx);

    const resolvedPaths = await resolveGlobs(params.paths, ctx.cwd);
    const objectIds: string[] = [];

    for (const filePath of resolvedPaths) {
      if (signal?.aborted) break;

      try {
        const content = await fs.promises.readFile(filePath, "utf-8");
        const obj = await state.store.add({
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

    state.phase = "idle";
    updateWidget(ctx);

    return {
      content: [{ type: "text", text: `Ingested ${objectIds.length} files. Object IDs:\n${objectIds.join("\n")}` }],
      details: { objectIds },
    };
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
      `Config: maxDepth=${state.config.maxDepth}, maxConcurrency=${state.config.maxConcurrency}`,
    ].join("\n");

    return { content: [{ type: "text", text }], details: {} };
  },
});
```

---

## 8. System Prompt Template

### 8.1 Root System Prompt Injection (FR-11)

Injected via `before_agent_start` when RLM is enabled:

```typescript
function buildSystemPrompt(manifest: string, config: RlmConfig): string {
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

${manifest}
`.trim();
}
```

### 8.2 Child System Prompt

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

## 9. Widget Rendering

### 9.1 Widget States (FR-6)

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
      // FR-6.3: On-idle state
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
    const cost = state.costEstimator.currentOperationCost();
    const costStr = cost > 0 ? ` | est. $${cost.toFixed(4)}` : "";

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

### 9.2 Inspector Overlay (FR-7)

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

## 10. Configuration and Persistence

### 10.1 Config Persistence

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

### 10.2 Store Persistence

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
    this.queue = this.queue.then(fn).catch(() => {});
    return this.queue;
  }
}
```

All `store.add()`, `store.flush()`, and index writes go through the queue.

### 10.3 Store Cleanup (FR-1.8)

On `session_start`, scan `.pi/rlm/` for session directories. Delete any
older than `config.retentionDays`:

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

## 11. Error Handling Strategy

### 11.1 Principle: Fail Safe, Never Crash Pi

Every event handler and tool executor wraps its body in try/catch. Errors
are logged and the extension degrades to vanilla Pi behavior.

```typescript
function safeHandler<T>(name: string, fn: (...args: any[]) => Promise<T>) {
  return async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error(`[pi-rlm] ${name} error:`, err);
      // For context/compact handlers: return undefined (no modification)
      // For tools: return error result
      return undefined;
    }
  };
}

// Usage:
pi.on("context", safeHandler("context", onContext));
pi.on("session_before_compact", safeHandler("compact", onBeforeCompact));
```

### 11.2 Graceful Degradation (FR-13)

```
Error in context handler → return undefined (Pi uses unmodified messages)
Error in compact handler → return undefined (Pi compacts normally)
Error in tool execution → return { content: [{ type: "text", text: error }], isError: true }
Error in store → log, notify user, set state.enabled = false
Error in child call → return structured error result, continue batch
```

### 11.3 Specific Error Cases

| Error | Response |
|-------|----------|
| Store JSONL corrupt | Rebuild index from valid lines, skip corrupt lines |
| `stream()` / `complete()` throws | Return error ChildCallResult, log to trajectory |
| Rate limit (429) | Retry 3x with exponential backoff (FR-5.11) |
| Child timeout | Abort via AbortSignal, return timeout result |
| Operation budget exceeded | Cancel remaining children, return partial results |
| Regex catastrophic backtracking | Abort after 5s, skip object, continue search |
| Disk full | Log error, disable externalization, allow compaction |
| `ctx.getContextUsage()` returns null | Skip externalization for this turn |
| Model has no cost metadata | Use 0 for estimates, note "cost unknown" in widget |

---

## 12. Implementation Phases

### Phase 1: Proof of Concept (1–2 weeks)

**Goal:** Validate that the core extension hooks work as designed. Prove that
`context` event modification, compaction cancellation, and `stream()` child
calls all function correctly together.

**Deliverables:**
1. Extension skeleton (`index.ts`) with event handler wiring
2. `ExternalStore` — JSONL read/write with in-memory index
3. `ContextExternalizer` — basic `context` handler that externalizes oldest
   messages when threshold exceeded, replaces with stubs
4. Compaction interceptor — `session_before_compact` returns `{ cancel: true }`
5. `rlm_peek` — retrieve slice from store
6. `rlm_search` — substring search (no regex yet)
7. `ManifestBuilder` — basic manifest in system prompt
8. Basic widget — shows on/off and object count
9. `/rlm`, `/rlm on`, `/rlm off` commands

**Validation:** Run Pi with the extension, have a long conversation, verify
compaction never fires, verify `rlm_peek` retrieves externalized content,
verify the model sees stubs and manifest.

### Phase 2: Recursive Engine (1–2 weeks)

**Goal:** Implement `rlm_query` and `rlm_batch` with the full recursive call
engine, cost estimation, and budget controls.

**Deliverables:**
1. `RecursiveEngine` with `query()` and `batch()` methods
2. `ConcurrencyLimiter` for parallel execution
3. `rlm_query` and `rlm_batch` tools with cost confirmation
4. `CallTree` for tracking active operations
5. `TrajectoryLogger` — JSONL logging of all recursive calls
6. `CostEstimator` using `model.cost` metadata
7. Child system prompt with structured output instructions
8. Budget limits and timeouts via `AbortSignal`
9. Widget active state — shows phase, depth, child count, budget, cost

**Validation:** Run `rlm_query` on externalized content and verify child
calls return structured results. Run `rlm_batch` across multiple objects and
verify parallel execution. Verify budget cancellation and timeout behavior.

### Phase 3: Robustness (1 week)

**Goal:** Harden the extension for real-world use. Add safety valves,
warm tracking, retry logic, and error handling.

**Deliverables:**
1. Safety valve (FR-3.8) — force-externalize at 90%, fallback to compaction
2. `WarmTracker` — prevent re-externalization of recently retrieved content
3. Rate-limit retry with exponential backoff (FR-5.11)
4. Child response validation and fallback wrapping (FR-5.12)
5. Regex timeout for `rlm_search` (NFR-3.5)
6. `WriteQueue` for serialized concurrent writes (NFR-3.4)
7. `safeHandler` wrapper on all event handlers (NFR-3.1)
8. Graceful degradation — disable on unrecoverable error (FR-13)
9. `rlm_ingest` tool for bulk file ingestion (FR-4.6)
10. First-run notification (FR-14)

**Validation:** Run stress tests — many concurrent `rlm_batch` children,
rapid externalization/retrieval cycles, large stores, model errors.

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
7. Store cleanup — delete old sessions (FR-1.8)
8. Tunable system prompt via config file (FR-11.5)
9. Model routing configuration (FR-5.7, FR-9.4)
10. Non-interactive mode support — check `ctx.hasUI` (NFR-1.5)
11. `pi.events` emission for inter-extension communication (NFR-4.3)
12. Unit tests for store, externalizer, engine, and manifest

---

## References

- [Pi-RLM Vision](vision.md)
- [Pi-RLM Requirements](requirements.md)
- [Pi Extension API](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- Zhang, A. L., Wei, D., Jang, L., & Madry, A. (2025). *Recursive Language
  Models.* MIT CSAIL. [arXiv:2512.24601](https://arxiv.org/abs/2512.24601)
