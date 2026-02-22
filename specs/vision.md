# Pi-RLM: Vision

## The Problem

Every coding agent hits the same wall. As a session grows — files read, tools
invoked, code written, errors debugged — the conversation history swells toward
the model's context window limit. When it gets there, the agent compacts: it
summarizes older turns, discards tool outputs, and throws away the raw details
that made those earlier interactions useful. This is lossy compression applied
to your working memory. The agent forgets.

Compaction isn't a bug — it's the only option when the entire session lives
inside the LLM's token window. But it has real consequences:

- **Information loss is irreversible.** A compacted summary of a 200-line stack
  trace can't answer the follow-up question you didn't think to ask yet.
- **Context rot degrades quality.** Even before compaction triggers, models lose
  recall accuracy as prompts grow past ~50K tokens. Details in the middle of
  long contexts are systematically missed.
- **Long-horizon tasks break down.** Multi-file refactors, whole-codebase
  audits, and complex debugging sessions require the agent to hold more context
  than any single LLM call can faithfully process.

RAG and vector search don't solve this either. They retrieve *similar* content,
not *the right* content for a specific reasoning step. They can't decompose a
task, process a thousand files systematically, and synthesize results — they can
only fetch snippets and hope the model connects the dots.

## The Insight

In late 2025, researchers at MIT CSAIL introduced Recursive Language Models
(RLMs). The core idea is deceptively simple:

> **Don't stuff context into the model. Store it externally, and let the model
> programmatically explore it.**

Instead of feeding an LLM a 200K-token prompt and praying it finds what it
needs, you store the data in an external environment and give the model tools to
inspect, search, slice, and — critically — **recursively sub-query** over
portions of it. The model writes a plan for how to process the data, executes it
step by step, and only the compact results of each step flow back into the
working context.

The key mechanism is **recursive self-invocation**: when a chunk of data is too
large or complex for a single pass, the model spawns a child call — a fresh,
isolated LLM invocation focused on just that chunk, with its own sub-query and
bounded context. Children can spawn their own children. Results propagate upward
as structured summaries, never as raw dumps. The parent model's working memory
stays clean.

This is not RAG. It's not summarization. It's the model **actively decomposing
and conquering** its own context, trading inference-time compute for analytical
depth. MIT demonstrated this working reliably over 10M+ tokens — 100x the base
context window — with quality that matches or exceeds frontier models running on
the raw input.

## The Vision

**Pi-RLM is an industrial-strength implementation of the RLM architecture, built
entirely as a Pi extension.** It makes every LLM interaction in Pi RLM-aware,
eliminating the need for compaction while preserving full compatibility with any
LLM provider Pi supports.

### Core Principles

1. **Zero compaction.** The Pi agent's active context stays small — always.
   Large content is externalized to an extension-owned store the moment it
   enters the system. The LLM sees compact references and uses RLM tools to
   access the underlying data on demand. Pi's built-in compaction is intercepted
   and replaced.

2. **Any model, any provider.** Pi-RLM is not married to a specific LLM. It uses
   Pi's `pi-ai` abstraction for all model calls — root and recursive alike. If
   Pi supports it, Pi-RLM works with it. Different models can be routed to
   different roles: a strong model for root reasoning, a fast/cheap model for
   recursive sub-calls.

3. **Pure Pi extension.** No forks. No patches to Pi's core. No external Python
   processes, MCP servers, or sidecar services. Pi-RLM is a TypeScript extension
   that uses Pi's public extension API: event hooks, tool registration, slash
   commands, widget rendering, session persistence. It installs like any other
   extension and is hot-reloadable via `/reload`.

4. **Infinite context illusion.** From the user's perspective, context is
   simply infinite. They see 100% of the conversation exactly as it happened:
   every prompt they typed, every response, every tool call and its output —
   nothing is hidden, summarized, or discarded from their view. RLM operations
   appear naturally in the chat as additional tool calls streamed inline, just
   like `read` or `bash`. The widget and `/rlm` commands provide extra
   visibility into what's happening underneath, but the baseline experience is
   a normal Pi session that never runs out of memory. The complexity of context
   externalization, recursive decomposition, and LLM context management is
   handled entirely beneath the surface. The user operates under an RLM blanket
   that is fully transparent when they want to look through it, and invisible
   when they don't.

5. **Full observability.** The RLM blanket is transparent, not opaque.
   Recursive sub-calls are not a black box. A persistent TUI widget shows the
   current RLM state: mode, phase, recursion depth, token budget, active query.
   An inspector overlay visualizes the call tree in real time. Every recursive
   invocation is logged to a trajectory file for debugging and auditing. The
   user can always see *why* the agent is doing what it's doing — but they
   never *have* to.

6. **Security is external.** Pi-RLM does not implement sandboxing, OS-level
   isolation, or code execution guardrails. Those concerns are handled by the
   host environment (containers, sandboxes, infrastructure policy). This keeps
   the extension focused on what it does best: context management and recursive
   orchestration.

## What This Enables

With Pi-RLM, the coding agent can:

- **Run indefinitely without degradation.** Sessions can last hours or days.
  Context is externalized continuously; the working window never bloats. There
  is no compaction cliff.

- **Operate on entire codebases.** "Audit all 500 files in src/ for race
  conditions" becomes a tractable operation: the extension chunks the codebase,
  dispatches parallel recursive queries to a fast sub-model, collects structured
  findings, and synthesizes a report — all while the root context stays under
  10K tokens.

- **Maintain perfect recall.** Nothing is summarized away. Every file read,
  every tool output, every intermediate result is preserved in the external
  store and accessible via RLM tools. The model can always go back and look at
  the raw data.

- **Control costs.** Recursive sub-calls can be routed to cheaper, faster
  models. A strong root model plans the work; lightweight children execute it.
  Parallelism reduces wall-clock time. Budget limits prevent runaway spend.

- **Stay fully auditable.** Every recursive call — its query, its context slice,
  its model, its result, its token usage — is logged to a JSONL trajectory file.
  You can replay, inspect, and debug the agent's entire reasoning process after
  the fact.

## What This Is Not

- **Not a fork of Pi.** Pi-RLM is a standard extension. It does not modify Pi's
  core agent loop, session format, or built-in tools.

- **Not a standalone service.** There is no separate process, no MCP server, no
  Python runtime. Everything runs in-process in Pi's Node.js/TypeScript
  environment.

- **Not a sandbox.** Code execution safety, file system isolation, and network
  access controls are the responsibility of the host environment, not this
  extension.

- **Not a replacement for Pi's agent.** Pi remains the agent. Pi-RLM augments it
  with better context management and recursive capabilities. The user experience
  is the same Pi TUI — just with a widget showing RLM state and tools that let
  the model think deeper.

## Success Criteria

Pi-RLM succeeds when:

1. A Pi session can run for **an arbitrarily long time** without triggering
   compaction and without degradation in the agent's recall or reasoning
   quality.

2. The agent can perform **whole-codebase operations** (audits, migrations,
   cross-cutting refactors) that would be impossible in a single context window,
   with results that are accurate and complete.

3. The extension works with **every LLM provider** Pi supports, with no
   provider-specific code paths.

4. A developer can **see what the agent is doing** at every level of recursion,
   in real time, without leaving the Pi TUI.

5. The extension installs and works **without any changes to Pi's core** — today
   and through future Pi updates.

## References

- Zhang, A. L., Wei, D., Jang, L., & Madry, A. (2025). *Recursive Language
  Models.* MIT CSAIL. [arXiv:2512.24601](https://arxiv.org/abs/2512.24601)
