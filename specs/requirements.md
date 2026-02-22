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
`context` event, (b) cancelling or customizing compaction via
`session_before_compact`, (c) making child LLM calls via `pi-ai` from extension
code, (d) registering custom tools with TypeBox schemas, (e) rendering TUI
widgets via `setWidget` and overlays via `ui.custom()`, and (f) persisting
extension state via `appendEntry`. An early feasibility spike must validate
these before detailed design. See [Risk R-4](#r-4-extension-api-surface).

**A-2: Models are competent RLM strategists.** The architecture depends on the
LLM knowing when to use RLM tools, writing effective decomposition strategies,
producing focused recursive sub-queries, and synthesizing results from children
into coherent answers. The MIT paper demonstrated this with frontier models on
controlled tasks. See [Risk R-2](#r-2-model-competence).

**A-3: Security is external.** Pi-RLM does not implement sandboxing, OS-level
isolation, or code execution guardrails. The host environment provides these.

**A-4: Users pay their own API costs.** Recursive operations multiply LLM calls.
Cost visibility and budget controls are essential, not optional.

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
override (`/rlm externalize`) for users who want direct control.

<a id="r-4-extension-api-surface"></a>
**R-4: Extension API surface.** If Pi's `context` event does not support deep
enough message modification, or if `pi-ai` cannot be invoked for child calls
from extension code, Principle 3 (pure extension) fails.

*Mitigation:* Feasibility spike before design commitment. If gaps are found,
propose minimal Pi core changes as PRs rather than forking.

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

**FR-1.5** [SHOULD] The store **should** use JSONL format for append-only
durability and human readability. An index file (`index.json`) **should**
provide fast lookup without scanning the full log.

**FR-1.6** [SHOULD] The store **should** support content over 10MB total per
session, consistent with the paper's demonstrated 10M+ token operation.

**FR-1.7** [MAY] The store **may** support cross-session references, enabling
the session resume use case where a new session recovers context from a
previous session's store.

### FR-2: Context Manifest

**FR-2.1** [MUST] The extension **must** maintain a context manifest — a
compact summary of all externalized objects — that is injected into the LLM's
working context via the `context` event or `before_agent_start`.

**FR-2.2** [MUST] The manifest **must** include, for each externalized object:
its identifier, content type, estimated token count, and a brief description
(e.g., "stack trace from auth.ts, 847 tokens").

**FR-2.3** [MUST] The manifest **must** stay small relative to the context
window. It **must not** exceed a configurable token budget (default: 2,000
tokens). If the manifest would exceed this budget, it **must** be summarized
or paginated.

**FR-2.4** [SHOULD] The manifest **should** be ordered by recency, with the
most recently externalized objects first, so the model sees the most relevant
context pointers at the top.

### FR-3: Context Externalization

**FR-3.1** [MUST] The extension **must** hook into Pi's `context` event to
intercept and modify the message array before each LLM call.

**FR-3.2** [MUST] When context usage exceeds a configurable threshold (default:
60% of the model's context window, measured via `ctx.getContextUsage()`), the
extension **must** externalize the oldest/largest content from the message array,
replacing it with a manifest stub.

**FR-3.3** [MUST] Externalized content **must** be replaced in the message
array with a compact reference (e.g., `[rlm-ref:<id>]`) so the LLM sees a
pointer, not the raw content.

**FR-3.4** [MUST] The extension **must** hook into `session_before_compact` and
cancel Pi's native compaction when RLM externalization is active. The extension
handles context size management; Pi's compaction is unnecessary.

**FR-3.5** [SHOULD] The extension **should** prioritize externalization of
large tool outputs (file reads, bash results) over conversation turns, since
tool outputs are typically larger and more retrievable.

**FR-3.6** [SHOULD] The extension **should** never externalize the most recent
user message or the most recent assistant response, preserving conversational
continuity.

**FR-3.7** [MAY] The extension **may** support a manual externalization command
(`/rlm externalize`) that forces immediate externalization regardless of
threshold.

### FR-4: RLM Tools

The extension registers tools that the LLM can call to interact with
externalized content. These mirror the MIT paper's REPL environment primitives.

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

**FR-4.4** [SHOULD] `rlm_batch` — Spawn multiple recursive child calls in
parallel, each processing a different object or partition. Parameters:
`instructions` (string), `targets` (array of object IDs),
`model` (optional). Returns an array of structured responses.

**FR-4.5** [SHOULD] `rlm_stats` — Return current RLM state: number of
externalized objects, total estimated tokens in store, context window usage,
recursion depth, active child calls. No parameters.

**FR-4.6** [MAY] `rlm_extract` — Extract structured facts from an externalized
object and store them as a new object in the store. Parameters: `source` (object
ID), `instructions` (string). Returns the new object's ID.

**FR-4.7** [MUST] All RLM tools **must** be registered via `pi.registerTool()`
with TypeBox parameter schemas. They appear to the LLM identically to Pi's
built-in tools.

**FR-4.8** [MUST] All RLM tools **must** truncate their output to stay within
Pi's output limits (50KB / 2000 lines) using Pi's truncation utilities. If
output is truncated, the tool **must** indicate this and provide the object ID
for the model to retrieve more.

### FR-5: Recursive Call Engine

**FR-5.1** [MUST] The extension **must** support recursive LLM invocations:
a child call that runs in isolation with its own context, focused on a specific
sub-query and data slice.

**FR-5.2** [MUST] Child calls **must** use Pi's `pi-ai` abstraction for model
invocation. They **must not** spawn new Pi processes (no `exec("pi", ...)`);
they run in-process.

**FR-5.3** [MUST] Each child call **must** have: a dedicated system prompt
describing the RLM environment and available tools, the target data slice
injected as context, and a bounded token budget.

**FR-5.4** [MUST] Child calls **must** return structured results to the parent
(not raw text dumps). The parent sees a concise summary/answer, not the child's
full conversation.

**FR-5.5** [MUST] Maximum recursion depth **must** be configurable (default: 2).
A child at the maximum depth **must not** spawn further children.

**FR-5.6** [MUST] Each recursive call **must** be assigned a unique call ID
and tracked in a call tree for observability and debugging.

**FR-5.7** [SHOULD] The engine **should** support routing child calls to a
different (typically cheaper/faster) model than the root model. Model routing
is configurable per session.

**FR-5.8** [SHOULD] `rlm_batch` **should** execute child calls in parallel
with configurable concurrency (default: 4).

**FR-5.9** [SHOULD] The engine **should** enforce a per-operation token budget.
If a recursive tree exceeds its budget, remaining children are cancelled and
partial results are returned.

**FR-5.10** [MAY] Children **may** have access to a subset of RLM tools
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

**FR-6.4** [MUST] When RLM is actively processing (externalizing, querying,
recursing, synthesizing), the widget **must** display: current phase, recursion
depth, active child call count, and token budget usage.

**FR-6.5** [SHOULD] The widget **should** show estimated token counts:
tokens in working context vs. tokens in external store.

**FR-6.6** [SHOULD] The widget **should** show cost estimate for the current
recursive operation (estimated total LLM calls × estimated cost per call).

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
mid-flight. Cancellation **must** abort all active child calls and return
partial results to the root. The working context **must not** be corrupted by
cancellation.

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
| `manifestBudget` | 2000 | Max tokens for manifest |
| `enabled` | true | RLM mode on/off (toggled via `/rlm on` and `/rlm off`) |

**FR-9.4** [SHOULD] The user **should** be able to configure model routing:
which model to use for root calls vs. recursive child calls.

**FR-9.5** [SHOULD] Before expensive recursive operations (estimated >10 LLM
calls), the extension **should** display an estimated cost and request user
confirmation via `ctx.ui.confirm()`.

**FR-9.6** [SHOULD] The extension **should** enforce a per-operation budget
limit (configurable, default: 50 child calls). Operations exceeding the budget
are cancelled with partial results.

### FR-10: Trajectory Logging

**FR-10.1** [MUST] Every recursive call **must** be logged to a trajectory
file: call ID, parent call ID, depth, model used, input (query + context
summary), output (response summary), token usage (input + output), wall-clock
time, and status (success/error/cancelled).

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

**FR-11.2** [MUST] The system prompt injection **must** include strategy
examples showing common patterns: search-then-peek, partition-and-query,
map-reduce over file sets.

**FR-11.3** [SHOULD] The system prompt **should** instruct the model to verify
retrieved content matches the user's reference before relying on it, mitigating
retrieval failure risk (R-5).

**FR-11.4** [SHOULD] The system prompt **should** be tunable — advanced users
can override the default RLM instructions via a configuration file.

### FR-12: Session Persistence and Resume

**FR-12.1** [MUST] Extension state (store index, configuration, manifest)
**must** persist via `pi.appendEntry()` so it survives Pi restarts.

**FR-12.2** [MUST] On `session_start`, the extension **must** reconstruct its
in-memory state from persisted session entries and the on-disk store.

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

**FR-13.3** [SHOULD] If a recursive child call fails (model error, timeout),
the parent **should** receive a structured error result and continue processing
remaining children rather than aborting the entire operation.

---

## Non-Functional Requirements

### NFR-1: Compatibility

**NFR-1.1** [MUST] The extension **must** work with every LLM provider Pi
supports, using `pi-ai` for all model calls.

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

**NFR-2.1** [MUST] The `context` event handler **must** complete in <100ms.
Context manipulation is on the hot path of every LLM call.

**NFR-2.2** [MUST] RLM tool registration and manifest injection **must not**
add measurable latency to sessions where RLM never activates (zero footprint
default).

**NFR-2.3** [SHOULD] `rlm_peek` and `rlm_search` **should** complete in <500ms
for stores up to 10MB. These are called frequently by the model during
exploration.

**NFR-2.4** [SHOULD] Store operations (read, write, index lookup) **should**
be async and non-blocking.

**NFR-2.5** [SHOULD] Parallel child calls (`rlm_batch`) **should** use
`Promise.all` with concurrency limiting, not sequential execution.

### NFR-3: Reliability

**NFR-3.1** [MUST] Extension errors **must not** crash Pi. All event handlers
and tool executors **must** catch exceptions and fail gracefully.

**NFR-3.2** [MUST] The external store **must** be append-only during a session.
No store operation deletes or overwrites previously written content.

**NFR-3.3** [SHOULD] The store **should** be crash-safe: if Pi is killed
mid-write, the store should be recoverable on next startup (JSONL append-only
provides this naturally).

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

**NFR-5.2** [SHOULD] The extension **should** estimate cost per operation using
Pi's model cost metadata (`ctx.modelRegistry`).

**NFR-5.3** [SHOULD] Model routing (strong root, cheap children) **should**
be the default configuration, consistent with the paper's Pareto-efficient
economics.

---

## Traceability Matrix

| Vision Principle | Requirements |
|-----------------|--------------|
| 1. Compaction is irrelevant | FR-1, FR-2, FR-3 |
| 2. Any model, any provider | FR-5.2, FR-5.7, FR-9.4, NFR-1.1 |
| 3. Pure Pi extension | FR-4.7, NFR-1.2, NFR-1.3 |
| 4. Infinite context illusion | FR-2, FR-3.6, FR-4.1–4.3, FR-11, FR-13 |
| 5. Full observability and control | FR-6, FR-7, FR-8, FR-9, FR-10 |
| 6. Security is external | A-3 |

| Vision Success Criterion | Requirements |
|-------------------------|--------------|
| 1. No compaction, no degradation | FR-3.4, FR-1.6 |
| 2. Whole-codebase operations | FR-4.3, FR-4.4, FR-5 |
| 3. Seamless infinite context | FR-2, FR-3, FR-4, FR-11 |
| 4. Full observability and control | FR-6–FR-10 |
| 5. Every LLM provider | NFR-1.1, FR-5.2 |
| 6. No core changes | NFR-1.2 |

## References

- [Pi-RLM Vision](vision.md)
- [Pi Extension API](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- Zhang, A. L., Wei, D., Jang, L., & Madry, A. (2025). *Recursive Language
  Models.* MIT CSAIL. [arXiv:2512.24601](https://arxiv.org/abs/2512.24601)
