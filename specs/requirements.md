# Pi-RLM: Requirements

This document specifies the functional and non-functional requirements for
Pi-RLM, derived from the [vision](vision.md) and grounded in the capabilities
of [Pi's extension API](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md).

Requirements are tagged **[MUST]**, **[SHOULD]**, or **[MAY]** per RFC 2119.

---

## Assumptions and Risks

### Assumptions

**A-1: Pi's extension API is sufficient.** The design assumes Pi's public
extension API supports: (a) intercepting and modifying LLM context via the
`context` event (confirmed: provides a deep copy of messages, modifications
affect only what the LLM sees, not what the user sees in the TUI),
(b) cancelling or customizing compaction via `session_before_compact`,
(c) making child LLM calls via `pi-ai`'s exported `stream()` and `complete()`
functions (confirmed: `stream(model, context, options)` takes a `Model`, a
`Context` with system prompt + messages + tools, and returns an
`AssistantMessageEventStream`; `StreamOptions` includes `signal?: AbortSignal`
for cancellation and `maxTokens` for budget control), (d) registering custom
tools with TypeBox parameter schemas via `pi.registerTool()`, (e) rendering TUI
widgets via `ctx.ui.setWidget()` and overlays via `ctx.ui.custom()`,
(f) persisting extension state via `pi.appendEntry()`, (g) injecting system
prompt modifications via `before_agent_start`, (h) flushing state on session
switch via `session_before_switch`, (i) querying context usage via
`ctx.getContextUsage()`, (j) user interaction via `ctx.ui.confirm()`,
`ctx.ui.notify()`, and `ctx.ui.select()`, (k) checking for UI availability via
`ctx.hasUI`, (l) resolving models via `ctx.modelRegistry` (confirmed: `Model`
interface includes `contextWindow`, `maxTokens`, `cost`, and `provider`),
(m) inter-extension communication via `pi.events`, and (n) session lifecycle
via `session_start` (confirmed: 10 references in extension docs, used for
initialization and state reconstruction).

**A-2: Models are competent RLM strategists.** The architecture depends on the
LLM knowing when to use RLM tools, writing effective decomposition strategies,
producing focused recursive sub-queries, and synthesizing results from children
into coherent answers. The MIT paper demonstrated this with frontier models on
controlled tasks. See [Risk R-2](#r-2-model-competence).

**A-3: Security is external.** Pi-RLM does not implement sandboxing, OS-level
isolation, or code execution guardrails. The host environment provides these.

**A-4: Users pay their own API costs.** Recursive operations multiply LLM calls.
Cost visibility and budget controls are essential, not optional.

**A-5: Exploration strategies via tool orchestration.** The MIT paper describes
models writing "programs with loops, conditionals, and recursive sub-calls" in
a REPL environment. Pi-RLM achieves the same decomposition through tool-call
chaining in Pi's agent loop: `rlm_search` → `rlm_peek` → `rlm_query` for
sequential exploration, `rlm_batch` for parallel "loop over N items" patterns.
This is safer than executing arbitrary code and leverages Pi's existing tool
infrastructure.

### Risks

<a id="r-1-generalization-gap"></a>
**R-1: The generalization gap.** The MIT paper demonstrated RLMs on batch
analytical tasks — processing large corpora, codebase understanding, research
synthesis. A coding agent session is fundamentally different: interactive,
stateful, incremental, and heterogeneous. The paper provides strong evidence
the mechanism works; the risk is generalizing from controlled experiments to
the open-ended environment of a real coding session. This is the central
technical risk of the project.

*Mitigation:* Phase the rollout. Start with batch-like operations (codebase
audits, file processing) where the paper's results apply most directly.
Extend to interactive context management only after validating the core engine.

<a id="r-2-model-competence"></a>
**R-2: Model competence as RLM strategist.** If the model over-recurses on
simple questions, under-recurses on complex ones, or chooses the wrong tool,
the system degrades to a slower, more expensive version of normal Pi. Not all
models are equally capable; the extension may need to adapt behavior based on
model capability.

*Mitigation:* Conservative defaults (low recursion depth, budget caps).
Provide the model with rich environment descriptions and strategy examples in
the system prompt. Allow users to override defaults per session.

<a id="r-3-externalization-timing"></a>
**R-3: Externalization timing.** When does content move from working context to
external store? Too early and short sessions pay a retrieval tax. Too late and
compaction fires first. Getting the heuristics wrong in either direction
degrades the experience.

*Mitigation:* Token-budget-based trigger: externalize when context usage
exceeds a configurable threshold (e.g., 60% of window). Provide manual
override (`/rlm externalize`) for users who want direct control. Safety valve
at 90% (see FR-3.8).

<a id="r-4-extension-api-surface"></a>
**R-4: Extension API surface.** The critical capabilities have been confirmed
in Pi's public API: the `context` event supports message array modification
(deep copy — user sees originals, LLM sees modified version),
`session_before_compact` supports cancellation, `pi-ai` exports `stream()` and
`complete()` for direct in-process LLM calls with `AbortSignal` support, and
`registerTool`/`setWidget`/`appendEntry` cover tools, UI, and persistence. The
remaining risk is undocumented edge cases — e.g., whether `stream()` works
correctly when called concurrently from parallel `rlm_batch` children.

*Mitigation:* Build a minimal proof-of-concept extension early in Phase 1 that
exercises context modification, compaction cancellation, and a `stream()` child
call from a tool handler.

<a id="r-5-retrieval-failure"></a>
**R-5: Retrieval failure.** When the model retrieves the wrong externalized
content, it may confabulate with false confidence — worse than compaction, where
the model at least knows information is missing.

*Mitigation:* The context manifest gives the model structural awareness of
what exists. The model's system prompt must instruct it to verify retrieved
content matches the user's reference before relying on it.

---

## Functional Requirements

### FR-1: External Context Store

**FR-1.1** [MUST] The extension **must** maintain an external context store
that holds content externalized from the LLM's working context.

**FR-1.2** [MUST] The store **must** support heterogeneous content types:
conversation turns, tool outputs, file contents, and extension-generated
artifacts (summaries, extractions, intermediate results).

**FR-1.3** [MUST] Each stored object **must** have: a unique identifier, a
content type tag, a creation timestamp, an estimated token count, and the raw
content.

**FR-1.4** [MUST] The store **must** persist to disk so that content survives
Pi restarts and session switches. Storage location: `.pi/rlm/<session-id>/`.
The on-disk store is the **source of truth** for all externalized content.

**FR-1.5** [SHOULD] The store **should** use JSONL format for append-only
durability and human readability. An index file (`index.json`) **should**
provide fast lookup without scanning the full log.

**FR-1.6** [SHOULD] The store **should** support content over 10MB total per
session, consistent with the paper's demonstrated 10M+ token operation.

**FR-1.7** [MAY] The store **may** support cross-session references, enabling
the session resume use case where a new session recovers context from a
previous session's store.

**FR-1.8** [SHOULD] The store **should** support cleanup of old session data.
Sessions older than a configurable retention period (default: 30 days)
**should** be eligible for automatic deletion. `/rlm clear` provides manual
cleanup for the current session.

### FR-2: Context Manifest

**FR-2.1** [MUST] The extension **must** maintain a context manifest — a
compact summary of all externalized objects — that is injected into the LLM's
working context via the `context` event or `before_agent_start`.

**FR-2.2** [MUST] The manifest **must** include, for each externalized object:
its identifier, content type, estimated token count, and a brief description
(e.g., "stack trace from auth.ts, 847 tokens").

**FR-2.3** [MUST] The manifest **must** stay small relative to the context
window. It **must not** exceed a configurable token budget (default: 2,000
tokens). If the manifest would exceed this budget, older entries **must** be
collapsed into a summary line (e.g., "+47 older objects, 128K tokens total")
and the model can use `rlm_stats` or `rlm_search` to explore them.

**FR-2.4** [SHOULD] The manifest **should** be ordered by recency, with the
most recently externalized objects first, so the model sees the most relevant
context pointers at the top.

### FR-3: Context Externalization

**FR-3.1** [MUST] The extension **must** hook into Pi's `context` event to
intercept and modify the message array before each LLM call. The `context`
event provides a **deep copy** of the messages — modifications affect only what
the LLM sees, not what the user sees in the TUI scroll-back.

**FR-3.2** [MUST] When context usage exceeds a configurable threshold (default:
60% of the model's context window, measured via `ctx.getContextUsage()`), the
extension **must** externalize the oldest/largest content from the message array,
replacing it with a manifest stub.

**FR-3.3** [MUST] Externalized content **must** be replaced in the LLM's
message array with a compact reference (e.g., `[rlm-ref:<id>]`) so the LLM
sees a pointer, not the raw content. These stubs are **never visible to the
user** — the user's TUI always shows the original, unmodified conversation.

**FR-3.4** [MUST] The extension **must** hook into `session_before_compact` and
cancel Pi's native compaction when RLM externalization is active. The extension
handles context size management; Pi's compaction is unnecessary.

**FR-3.5** [SHOULD] The extension **should** prioritize externalization of
large tool outputs (file reads, bash results) over conversation turns, since
tool outputs are typically larger and more retrievable.

**FR-3.6** [SHOULD] The extension **should** never externalize the most recent
user message or the most recent assistant response, preserving conversational
continuity.

**FR-3.7** [SHOULD] The extension **should** support a manual externalization
command (`/rlm externalize`) that forces immediate externalization regardless of
threshold, providing direct user control over context management (mitigates
Risk R-3).

**FR-3.8** [MUST] **Compaction safety valve.** If context usage exceeds 90%
after the normal externalization pass (FR-3.2), the extension **must**
force-externalize all content except the most recent user message, the most
recent assistant response, and the system prompt. If context usage *still*
exceeds 90% after force-externalization (i.e., the current turn alone is
enormous), the extension **must** allow Pi's native compaction to proceed as a
last resort rather than letting the LLM call fail.

**FR-3.9** [MUST] Content retrieved via `rlm_peek`, `rlm_search`, or
`rlm_query` **must** be flagged as "warm" in the context handler. Warm content
**must not** be eligible for re-externalization for a configurable number of
subsequent LLM calls (default: 3). This prevents retrieve-then-re-externalize
thrashing.

### FR-4: RLM Tools

The extension registers tools that the LLM can call to interact with
externalized content. The MIT paper's "exploration strategies as programs" are
expressed through tool-call chaining in Pi's agent loop: the model orchestrates
`rlm_search` → `rlm_peek` → `rlm_query` sequences for sequential exploration,
and `rlm_batch` for parallel map-reduce patterns.

**FR-4.1** [MUST] `rlm_peek` — Retrieve a slice of an externalized object by
identifier and byte/line offset. Parameters: `id` (string), `offset` (number),
`length` (number). Returns the requested slice as text.

**FR-4.2** [MUST] `rlm_search` — Search across all externalized objects using
a text pattern (substring or regex). Parameters: `pattern` (string),
`scope` (optional: specific object IDs or "all"). Returns matching snippets
with object IDs and offsets.

**FR-4.3** [MUST] `rlm_query` — Spawn a recursive child LLM call focused on a
specific externalized object or subset. Parameters: `instructions` (string),
`target` (object ID or array of IDs), `model` (optional: override child model).
Returns the child's structured response.

**FR-4.4** [MUST] `rlm_batch` — Spawn multiple recursive child calls in
parallel, each processing a different object or partition. Parameters:
`instructions` (string), `targets` (array of object IDs),
`model` (optional). Returns an array of structured responses. Without batch,
whole-codebase operations — a headline use case — are impractical.

**FR-4.5** [SHOULD] `rlm_stats` — Return current RLM state: number of
externalized objects, total estimated tokens in store, context window usage,
recursion depth, active child calls. No parameters.

**FR-4.6** [MUST] `rlm_ingest` — Ingest files directly into the external store
without reading them into the LLM's working context. Parameters: `paths`
(array of file paths or globs). Returns an array of object IDs for the
ingested files. This is the efficient path for whole-codebase operations —
without it, 500 files must be sequentially read into working context and
externalized via churn.

**FR-4.7** [MAY] `rlm_extract` — Extract structured facts from an externalized
object and store them as a new object in the store. Parameters: `source` (object
ID), `instructions` (string). Returns the new object's ID.

**FR-4.8** [MUST] All RLM tools **must** be registered via `pi.registerTool()`
with TypeBox parameter schemas. They appear to the LLM identically to Pi's
built-in tools.

**FR-4.9** [MUST] All RLM tools **must** truncate their output to stay within
Pi's output limits (50KB / 2000 lines) using Pi's exported truncation utilities
(`truncateHead`, `truncateTail`, `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`). If
output is truncated, the tool **must** indicate this and provide the object ID
for the model to retrieve more.

### FR-5: Recursive Call Engine

**FR-5.1** [MUST] The extension **must** support recursive LLM invocations:
a child call that runs in isolation with its own context, focused on a specific
sub-query and data slice.

**FR-5.2** [MUST] Child calls **must** use the `stream()` or `complete()`
functions exported by `@mariozechner/pi-ai` for direct, in-process LLM
completion. The model is resolved via `ctx.modelRegistry`. No agent session, no
process spawning, no lock files — just a function call with a system prompt,
messages, and (optionally) tools. `StreamOptions.signal` provides cancellation
via `AbortSignal`; `StreamOptions.maxTokens` provides budget control.

**FR-5.3** [MUST] Each child call **must** have: a dedicated system prompt
describing the RLM environment and available tools, the target data slice
injected as context, and a bounded token budget.

**FR-5.4** [MUST] Child calls **must** return structured results to the parent
(not raw text dumps). The child's system prompt **must** instruct it to return
a JSON object with fields: `answer` (string), `confidence` (string: high/
medium/low), and `evidence` (array of relevant quotes or references). The
parent sees this structure, not the child's full conversation.

**FR-5.5** [MUST] Maximum recursion depth **must** be configurable (default: 2).
A child at the maximum depth **must not** spawn further children.

**FR-5.6** [MUST] Each recursive call **must** be assigned a unique call ID
and tracked in a call tree for observability and debugging.

**FR-5.7** [SHOULD] The engine **should** support routing child calls to a
different (typically cheaper/faster) model than the root model. Model routing
is configurable per session.

**FR-5.8** [MUST] `rlm_batch` **must** execute child calls in parallel with
configurable concurrency (default: 4) using `Promise.all` with concurrency
limiting.

**FR-5.9** [MUST] The engine **must** enforce a per-operation child call limit
(configurable via `maxChildCalls`, default: 50). If a recursive tree exceeds
this limit, remaining children **must** be cancelled via `AbortSignal` and
partial results returned. See FR-9.6 for the user-facing control.

**FR-5.10** [MUST] Each child call **must** have a wall-clock timeout
(configurable, default: 120 seconds). Each recursive operation (the full
`rlm_query` or `rlm_batch` including synthesis) **must** have an operation
timeout (configurable, default: 600 seconds). Timeouts **must** be enforced
via `AbortSignal`. Timed-out calls **must** return structured error results.

**FR-5.11** [SHOULD] When a child call fails due to rate limiting (HTTP 429),
the engine **should** retry with exponential backoff (initial delay 1s, max 3
retries) before returning a structured error. For `rlm_batch`, the engine
**should** reduce effective concurrency when rate limits are detected.

**FR-5.12** [MUST] Child call responses **must** be validated against the
expected structure (FR-5.4). If the child returns unstructured text instead of
the expected JSON, the engine **must** wrap it as `{ answer: <raw text>,
confidence: "low", evidence: [] }` rather than failing.

**FR-5.13** [MAY] Children **may** have access to a subset of RLM tools
(e.g., `rlm_peek` and `rlm_search` but not `rlm_query`) to limit recursion
complexity at deeper levels.

### FR-6: User Interface — Widget

**FR-6.1** [MUST] The extension **must** render a persistent TUI widget via
`ctx.ui.setWidget()` that is always visible, showing the current RLM state.

**FR-6.2** [MUST] When RLM is off, the widget **must** display "RLM: off"
(minimal, single line).

**FR-6.3** [MUST] When RLM is on but idle (no active externalization or
recursive calls), the widget **must** display "RLM: on" with basic stats:
number of externalized objects and total tokens in the external store.

**FR-6.4** [MUST] When RLM is actively processing, the widget **must** display:
current phase, recursion depth, active child call count, and token budget
usage. Phases are a closed set: `externalizing` (moving content to store),
`searching` (rlm_search in progress), `querying` (rlm_query child call active),
`batching` (rlm_batch parallel calls active), `synthesizing` (parent
processing child results), `ingesting` (rlm_ingest reading files to store).

**FR-6.5** [SHOULD] The widget **should** show estimated token counts:
tokens in working context vs. tokens in external store.

**FR-6.6** [MUST] The widget **must** show cost estimate for the current
recursive operation (estimated total LLM calls × estimated cost per call),
using model cost metadata from `ctx.modelRegistry` (which provides per-model
`cost.input` and `cost.output` rates). Cost visibility is essential per A-4.

**FR-6.7** [MAY] The widget **may** support placement configuration
(above/below editor) via extension settings.

### FR-7: User Interface — Inspector Overlay

**FR-7.1** [SHOULD] The extension **should** provide an inspector overlay
(via `ctx.ui.custom()`) that visualizes the recursive call tree in real time.

**FR-7.2** [SHOULD] The inspector **should** display: each call node (ID,
model, query summary, status), parent-child relationships, per-call token
usage, and elapsed time.

**FR-7.3** [SHOULD] The inspector **should** be accessible via `/rlm inspect`
or a keyboard shortcut.

**FR-7.4** [MAY] The inspector **may** support selecting a call node to view
its full input, output, and tool trace.

### FR-8: User Interface — Commands

**FR-8.1** [MUST] The extension **must** register the following slash commands
via `pi.registerCommand()`:

| Command | Description |
|---------|-------------|
| `/rlm` | Show RLM status summary (on/off, store size, active operations) |
| `/rlm on` | Enable RLM mode (default). Externalization, compaction interception, and RLM tools are active. |
| `/rlm off` | Disable RLM mode. RLM tools are deregistered, compaction interception is removed, Pi reverts to standard behavior. External store is preserved on disk. |

**FR-8.2** [SHOULD] The extension **should** register additional commands:

| Command | Description |
|---------|-------------|
| `/rlm config` | View/edit RLM settings (depth, model, budget, threshold) |
| `/rlm inspect` | Open the recursive call tree inspector overlay |
| `/rlm externalize` | Force immediate externalization of current context |
| `/rlm store` | Show external store contents (object list with sizes) |

**FR-8.3** [MAY] The extension **may** register:

| Command | Description |
|---------|-------------|
| `/rlm trace` | Export the trajectory log for the current session |
| `/rlm clear` | Clear the external store for the current session |

### FR-9: User Control

**FR-9.1** [MUST] The user **must** be able to cancel a recursive operation
mid-flight. Cancellation **must** abort all active child calls via
`AbortSignal` and return partial results to the root. The working context
**must not** be corrupted by cancellation.

**FR-9.2** [MUST] RLM processing **must** default to on. The user **must** be
able to toggle it off (`/rlm off`) and on (`/rlm on`) at any time mid-session.
When off: compaction interception is removed, RLM tools are unavailable, the
`context` event handler passes through unchanged, and Pi operates with standard
compaction. When re-enabled: the extension restores RLM state from the persisted
store and resumes externalization. The external store is never deleted by
toggling off — only the active behavior changes.

**FR-9.3** [MUST] The following parameters **must** be user-configurable:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxDepth` | 2 | Maximum recursion depth |
| `maxConcurrency` | 4 | Parallel child calls for `rlm_batch` |
| `tokenBudgetPercent` | 60 | Context % threshold for externalization |
| `safetyValvePercent` | 90 | Context % threshold for force-externalization |
| `manifestBudget` | 2000 | Max tokens for manifest |
| `warmTurns` | 3 | Turns retrieved content stays warm (exempt from re-externalization) |
| `childTimeoutSec` | 120 | Wall-clock timeout per child call |
| `operationTimeoutSec` | 600 | Wall-clock timeout per recursive operation |
| `maxChildCalls` | 50 | Per-operation child call budget |
| `childMaxTokens` | 4096 | Max output tokens per child call (`StreamOptions.maxTokens`) |
| `enabled` | true | RLM mode on/off (toggled via `/rlm on` and `/rlm off`) |

**FR-9.4** [SHOULD] The user **should** be able to configure model routing:
which model to use for root calls vs. recursive child calls.

**FR-9.5** [MUST] Before expensive recursive operations (estimated >10 LLM
calls), the extension **must** display an estimated cost and request user
confirmation via `ctx.ui.confirm()`. In non-interactive modes (`ctx.hasUI` is
false), the extension **must** proceed without confirmation but log the
estimated cost. Cost visibility is essential per A-4.

**FR-9.6** [MUST] The per-operation child call limit (FR-5.9) **must** be
enforced. Operations exceeding `maxChildCalls` **must** be cancelled with
partial results returned.

### FR-10: Trajectory Logging

**FR-10.1** [MUST] Every recursive call **must** be logged to a trajectory
file: call ID, parent call ID, depth, model used, input (query + context
summary), output (response summary), token usage (input + output), wall-clock
time, and status (success/error/cancelled/timeout).

**FR-10.2** [MUST] The trajectory file **must** be stored alongside the
external context store at `.pi/rlm/<session-id>/trajectory.jsonl`.

**FR-10.3** [SHOULD] The trajectory log **should** be viewable via
`/rlm trace` or the inspector overlay.

### FR-11: Model Education

**FR-11.1** [MUST] The extension **must** inject RLM-specific instructions
into the system prompt via `before_agent_start`, describing:
- What RLM tools are available and when to use them
- The context manifest format and how to interpret it
- When to use `rlm_query` (complex, large content) vs. direct tools (simple,
  small content)
- The cost of RLM operations (latency, tokens) relative to direct tools
- That exploration strategies are expressed through tool-call chaining (e.g.,
  search → peek → query), not through code generation

**FR-11.2** [SHOULD] The system prompt injection **should** include strategy
examples showing common patterns: search-then-peek, partition-and-query,
map-reduce over file sets via `rlm_batch`.

**FR-11.3** [MUST] The system prompt **must** instruct the model to verify
retrieved content matches the user's reference before relying on it, mitigating
retrieval failure risk (R-5).

**FR-11.4** [MUST] The system prompt **must** instruct the model to
proactively use RLM tools (`rlm_search`, `rlm_peek`) to recover externalized
content when the user references information that is not in the current working
context. E.g., if the user says "remember that bug you found in auth.ts?" and
the relevant content has been externalized, the model should search for it
before responding, not claim it doesn't have the information.

**FR-11.5** [SHOULD] The system prompt **should** be tunable — advanced users
can override the default RLM instructions via a configuration file.

### FR-12: Session Persistence and Resume

**FR-12.1** [MUST] Extension metadata (store index snapshot, configuration,
current manifest) **must** persist via `pi.appendEntry()` so it can be
reconstructed after Pi restarts. The on-disk store (FR-1.4) is the source of
truth for content; `appendEntry` stores lightweight metadata for fast
reconstruction without re-scanning the store.

**FR-12.2** [MUST] On `session_start`, the extension **must** reconstruct its
in-memory state from persisted session entries and the on-disk store. If
session entries and store are inconsistent (e.g., after a crash), the on-disk
store takes precedence and the index is rebuilt.

**FR-12.3** [SHOULD] The extension **should** support session resume: when a
new session is created, it **should** be possible to reference the external
store of a previous session, recovering full context without re-reading files.

**FR-12.4** [SHOULD] The extension **should** handle the `session_before_switch`
event to flush any pending state before switching sessions.

### FR-13: Graceful Degradation

**FR-13.1** [MUST] If the extension encounters an unrecoverable error (store
corruption, `pi-ai` failure, unexpected API change), it **must** log the error,
notify the user, and fall back to vanilla Pi behavior (compaction enabled).

**FR-13.2** [MUST] A failed RLM operation **must not** corrupt the working
context. The LLM's conversation state **must** remain valid after any failure.

**FR-13.3** [MUST] If a recursive child call fails (model error, timeout,
rate limit), the parent **must** receive a structured error result and continue
processing remaining children rather than aborting the entire operation.
Partial results from completed children **must** be preserved.

### FR-14: First-Run Experience

**FR-14.1** [MUST] On the first `session_start` after installation, the
extension **must** display a one-time notification via `ctx.ui.notify()`
informing the user that Pi-RLM is active, e.g.: "Pi-RLM is active. Use
`/rlm off` to disable. Use `/rlm` for status."

**FR-14.2** [MUST] The widget (FR-6.3) **must** include a hint about
`/rlm off` in the on-idle state, e.g.: "RLM: on (3 objects, 12K tokens) |
/rlm off to disable".

---

## Non-Functional Requirements

### NFR-1: Compatibility

**NFR-1.1** [MUST] The extension **must** work with every LLM provider Pi
supports, using `pi-ai` for all model calls. Token estimation for
externalization thresholds and manifest budgets **must** use
`ctx.getContextUsage()` (which uses the active model's tokenizer) for working
context, and a conservative character-based estimate (default: 4 characters per
token) for stored content.

**NFR-1.2** [MUST] The extension **must not** modify Pi's core agent loop,
session format, or built-in tools. It uses only the public extension API.

**NFR-1.3** [MUST] The extension **must** be hot-reloadable via `/reload`
without losing the external store (persisted on disk).

**NFR-1.4** [SHOULD] The extension **should** be forward-compatible: it
**should** degrade gracefully if future Pi versions change event signatures
or remove APIs, rather than crashing.

**NFR-1.5** [SHOULD] The extension **should** work in Pi's non-interactive
modes (print mode `-p`, JSON mode `--mode json`) by checking `ctx.hasUI`
before widget/dialog calls. In non-interactive modes, RLM tools still function
but UI elements are no-ops.

### NFR-2: Performance

**NFR-2.1** [MUST] The `context` event handler **must** complete in <100ms
for the common case (manifest injection + stub replacement for already-
externalized content). Disk writes for newly externalized content **must** be
async and **must not** block the handler's return.

**NFR-2.2** [MUST] Extension initialization (tool registration, event
subscription, widget setup) **must** complete in <200ms and **must not**
delay Pi's startup.

**NFR-2.3** [SHOULD] `rlm_peek` and `rlm_search` **should** complete in <500ms
for stores up to 10MB. These are called frequently by the model during
exploration.

**NFR-2.4** [SHOULD] Store operations (read, write, index lookup) **should**
be async and non-blocking.

**NFR-2.5** [MUST] Parallel child calls (`rlm_batch`) **must** use
`Promise.all` with concurrency limiting (FR-5.8), not sequential execution.

### NFR-3: Reliability

**NFR-3.1** [MUST] Extension errors **must not** crash Pi. All event handlers
and tool executors **must** catch exceptions and fail gracefully.

**NFR-3.2** [MUST] The external store **must** be append-only during a session.
No store operation deletes or overwrites previously written content.

**NFR-3.3** [SHOULD] The store **should** be crash-safe: if Pi is killed
mid-write, the store should be recoverable on next startup (JSONL append-only
provides this naturally).

**NFR-3.4** [MUST] Store writes from concurrent operations (e.g., parallel
`rlm_batch` children creating objects via `rlm_extract`) **must** be serialized
through a write queue. Concurrent async writers to JSONL files are not safe
without explicit serialization.

**NFR-3.5** [MUST] `rlm_search` regex patterns **must** be executed with a
timeout (default: 5 seconds per object). If a regex causes catastrophic
backtracking, the search **must** abort for that object and continue with
remaining objects, returning a partial result with an error note.

### NFR-4: Observability

**NFR-4.1** [MUST] All RLM operations **must** be logged to the trajectory
file (FR-10).

**NFR-4.2** [MUST] RLM tool calls **must** appear in the Pi chat as standard
tool call/result messages, identically to built-in tools.

**NFR-4.3** [SHOULD] The extension **should** emit events via `pi.events` for
inter-extension communication (e.g., `rlm:externalize`, `rlm:query:start`,
`rlm:query:end`).

### NFR-5: Economics

**NFR-5.1** [MUST] Token usage for every recursive call **must** be tracked
and reported (in trajectory log and widget).

**NFR-5.2** [MUST] The extension **must** estimate cost per operation using
Pi's model cost metadata (`ctx.modelRegistry`, which provides `cost.input` and
`cost.output` per model). Cost visibility is essential per A-4.

**NFR-5.3** [SHOULD] Model routing (strong root, cheap children) **should**
be the default configuration, consistent with the paper's Pareto-efficient
economics.

---

## Traceability Matrix

| Vision Principle | Requirements |
|-----------------|--------------|
| 1. Compaction is irrelevant | FR-1, FR-2, FR-3 (incl. FR-3.4 compaction cancellation, FR-3.8 safety valve, FR-3.9 keep-warm), FR-4, FR-11 |
| 2. Any model, any provider | FR-5.2, FR-5.7, FR-9.4, NFR-1.1 |
| 3. Pure Pi extension | FR-4.8, FR-4.9, FR-6.1, FR-8, FR-12.1, NFR-1.2, NFR-1.3 |
| 4. Infinite context illusion | FR-2, FR-3.1 (deep copy — user sees originals), FR-3.3 (stubs LLM-only), FR-3.6, FR-3.9, FR-4, FR-5, FR-9.2 (default on), FR-11 (incl. FR-11.4 proactive recovery), FR-12 (session persistence/resume), FR-13, FR-14, NFR-2 (performance — seamlessness requires low latency), NFR-4.2 |
| 5. Full observability and control | FR-6, FR-7, FR-8, FR-9, FR-10, NFR-3 (reliability), NFR-4, NFR-5 |
| 6. Security is external | A-3 |

| Vision Success Criterion | Requirements |
|-------------------------|--------------|
| 1. No compaction, no degradation | FR-1, FR-2, FR-3 (all), FR-11, FR-12, FR-13 |
| 2. Whole-codebase operations | FR-4.2, FR-4.3, FR-4.4, FR-4.6 (rlm_ingest), FR-5, FR-11 |
| 3. Seamless infinite context | FR-2, FR-3, FR-4, FR-6, FR-9.2, FR-11, FR-12, FR-13, FR-14, NFR-2, NFR-4.2 |
| 4. Full observability and control | FR-6, FR-7, FR-8, FR-9, FR-10, NFR-3, NFR-4, NFR-5 |
| 5. Every LLM provider | FR-5.2, FR-5.7, FR-9.4, NFR-1.1 |
| 6. No core changes | NFR-1.2, NFR-1.3 |

## References

- [Pi-RLM Vision](vision.md)
- [Pi Extension API](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- Zhang, A. L., Wei, D., Jang, L., & Madry, A. (2025). *Recursive Language
  Models.* MIT CSAIL. [arXiv:2512.24601](https://arxiv.org/abs/2512.24601)
