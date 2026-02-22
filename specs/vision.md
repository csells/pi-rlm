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
needs, you store the data in an external environment and give the model
**programmatic access** to it. The model doesn't just call tools — it writes
*exploration strategies*: programs with loops, conditionals, and recursive
sub-calls that inspect, search, slice, partition, and process the data. The
model is the active strategist, deciding how to decompose the problem and what
to examine. The environment provides the primitives; the model provides the
intelligence.

The key mechanism is **recursive self-invocation**: when a chunk of data is too
large or complex for a single pass, the model spawns a child call — a fresh,
isolated LLM invocation focused on just that chunk, with its own sub-query and
bounded context. Children can spawn their own children. Results propagate upward
as structured outputs, never as raw dumps. The parent model's working memory
stays clean.

This is not RAG. There is no embedding index, no vector similarity search, no
"find the most relevant chunks and hope the model connects the dots." The model
programmatically explores the data using code, not statistical similarity. It is
not summarization — nothing is discarded or lossy-compressed. It is the model
**actively decomposing and conquering** its own context, trading inference-time
compute for analytical depth.

The results are striking. MIT demonstrated RLMs working reliably over 10M+
tokens — **100x the base context window** — with quality that matches or exceeds
frontier models processing the raw input in a single pass. RLMs outperformed
both vanilla long-context models and conventional scaffolds (summarization, RAG,
retrieval agents) on dense reasoning tasks including deep research, codebase
understanding, and long-horizon analysis. The economics are favorable too: by
routing recursive sub-calls to cheaper, faster models, RLMs achieve superior
depth at a fraction of the cost of processing massive prompts through a frontier
model.

## The Vision

**Pi-RLM is an industrial-strength implementation of the RLM architecture, built
entirely as a Pi extension.** It makes every LLM interaction in Pi RLM-aware,
eliminating the need for compaction while preserving full compatibility with any
LLM provider Pi supports.

### Core Principles

1. **Compaction is irrelevant.** The Pi agent's context window becomes a
   workspace for active reasoning, not a warehouse for accumulated history.
   Large content is externalized to an extension-owned store, and the LLM has
   programmatic access to all of it on demand via RLM tools. The working context
   stays naturally small because the model only pulls in what it needs for the
   current reasoning step. Compaction doesn't need to be fought or replaced —
   it simply never triggers, because there's nothing to compact.

   Critically, the model always knows what it has. The working context contains
   a manifest of externalized objects — their identities, types, and sizes — so
   the model can make informed decisions about what to explore. This mirrors the
   paper's design, where the REPL environment describes its available variables
   to the model. The manifest is what makes the model a competent strategist
   rather than reaching blindly into a dark closet.

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

   The default experience is **zero footprint**. A fresh Pi session with Pi-RLM
   installed feels identical to vanilla Pi. No widget visible, no new commands
   in your face, no behavior change. The extension is completely silent until
   context pressure causes it to activate — at which point the user's first
   sign is simply the absence of degradation. Where vanilla Pi would compact
   and the agent would start forgetting, Pi-RLM just keeps working. That
   absence — the compaction that doesn't happen, the degradation that doesn't
   arrive — is the extension proving its value.

   There is an inherent gap between what the user sees (the full conversation)
   and what the LLM has in its working context (a pruned, externalized view).
   The RLM tools are the bridge. When the user references something that has
   been externalized — "remember that bug you found in auth.ts?" — the agent
   uses the same RLM tools it uses for everything else to recover the relevant
   context on demand. The user may occasionally see an `rlm_search` or
   `rlm_peek` call fire before the agent responds to a follow-up question.
   That's not a glitch — it's the agent remembering, visibly, using the same
   mechanism that powers everything else. The system is self-healing by design.

5. **Full observability and full control.** The RLM blanket is transparent, not
   opaque. Recursive sub-calls are not a black box. A persistent TUI widget
   shows the current RLM state: mode, phase, recursion depth, token budget,
   active query. An inspector overlay visualizes the call tree in real time.
   Every recursive invocation is logged to a trajectory file for debugging and
   auditing. The user can always see *why* the agent is doing what it's doing —
   but they never *have* to.

   Beyond observability, the user has **control**. They can adjust recursion
   depth, switch the model used for sub-calls, set budget limits, and cancel a
   recursive decomposition mid-flight. These are the same parameters the MIT
   paper used in its experiments (depth, model routing, budget), surfaced as
   user-facing controls rather than hidden configuration. The user can steer
   the RLM as precisely or as loosely as they want.

6. **Security is external.** Pi-RLM does not implement sandboxing, OS-level
   isolation, or code execution guardrails. Those concerns are handled by the
   host environment (containers, sandboxes, infrastructure policy). This keeps
   the extension focused on what it does best: context management and recursive
   orchestration.

## What This Enables

With Pi-RLM, the coding agent can:

- **Run indefinitely without degradation.** Sessions can last hours or days.
  The working context stays naturally small; there is no compaction cliff.
  The paper demonstrated reliable operation over 10M+ tokens — there is no
  inherent limit to session length.

- **Operate on entire codebases.** The paper showed RLMs outperforming both
  vanilla long-context models and conventional scaffolds on codebase
  understanding and dense reasoning tasks. "Audit all 500 files in src/ for
  race conditions" becomes a tractable operation: the model writes a
  decomposition strategy, dispatches parallel recursive queries to a fast
  sub-model, and synthesizes findings — all while the root context stays small.

- **Maintain perfect recall.** Nothing is summarized away. Every file read,
  every tool output, every intermediate result is preserved in the external
  store and accessible via RLM tools. The model can always go back and look at
  the raw data — and so can the user.

- **Trade latency for depth.** RLM operations involve multiple LLM calls and
  take longer than a single-pass response. This is an explicit, deliberate
  trade-off — the same one the paper makes. The payoff is that these operations
  *work* on tasks that single-pass calls cannot handle, and they maintain
  quality that degrades under conventional approaches. Recursive sub-calls can
  be routed to cheaper, faster models and parallelized to control both cost and
  wall-clock time. The paper demonstrated Pareto-efficient economics: superior
  depth at a fraction of the cost of processing massive prompts through a
  frontier model.

- **Stay fully auditable.** Every recursive call — its query, its context slice,
  its model, its result, its token usage — is logged to a trajectory file. You
  can replay, inspect, and debug the agent's entire reasoning process after the
  fact.

## What This Is Not

- **Not a fork of Pi.** Pi-RLM is a standard extension. It does not modify Pi's
  core agent loop, session format, or built-in tools.

- **Not a standalone service.** There is no separate process, no MCP server, no
  Python runtime. Everything runs in-process in Pi's Node.js/TypeScript
  environment.

- **Not a sandbox.** Code execution safety, file system isolation, and network
  access controls are the responsibility of the host environment, not this
  extension.

- **Not a RAG system.** There is no embedding index, no vector similarity
  search, no retrieval pipeline. The model programmatically explores externalized
  data using the RLM paper's mechanisms — not statistical similarity. The paper
  explicitly benchmarks against RAG-style approaches and demonstrates superior
  results on the target task class.

- **Not a replacement for Pi's agent.** Pi remains the agent. Pi-RLM augments it
  with better context management and recursive capabilities. The user experience
  is the same Pi TUI — just with a widget showing RLM state and tools that let
  the model think deeper.

## Assumptions and Risks

The architecture rests on one central assumption from the paper: **the model is
a competent RLM strategist.** The system depends on the LLM knowing when to use
RLM tools vs. normal Pi tools, writing effective decomposition strategies,
producing focused recursive sub-queries, and synthesizing results from multiple
children into coherent answers. The paper demonstrated that models can do this
well in controlled experiments on specific task types. The challenge is
generalizing from those experiments to the open-ended, interactive environment
of a coding agent session.

If the model is a poor strategist — over-recursing on simple questions,
under-recursing on complex ones, choosing the wrong tool — the system degrades
to a slower, more expensive version of normal Pi. The paper provides strong
evidence that this works; the risk is in the generalization, not the mechanism.

The model is as much a user of this system as the human is. The quality of the
experience — for both — depends on how well the model understands its RLM
environment: what's externalized, what tools are available, when to use them,
and what they cost in latency and tokens. The paper solved this with carefully
designed environment descriptions and prompts. **The model's understanding of
its RLM environment is a first-class design concern**, not an afterthought.

## Success Criteria

Pi-RLM succeeds when:

1. A Pi session can run for **an arbitrarily long time** without triggering
   compaction and without degradation in the agent's recall or reasoning
   quality — matching the paper's demonstrated reliability over 10M+ tokens.

2. The agent can perform **whole-codebase operations** (audits, migrations,
   cross-cutting refactors) that would be impossible in a single context window,
   with results that match or exceed what a frontier model achieves on raw
   input — consistent with the paper's benchmarks against vanilla long-context
   models.

3. The user experiences **seamless infinite context**: they see the full
   conversation, the agent can recover any externalized information on demand,
   and RLM operations appear as natural tool calls in the normal flow.

4. The user has **full observability and full control**: they can see the
   recursive call tree, adjust depth and budget and model routing, and cancel
   operations — at any time, without leaving the Pi TUI.

5. The extension works with **every LLM provider** Pi supports, with model
   routing between root and recursive calls as demonstrated in the paper's
   experiments.

6. The extension installs and works **without any changes to Pi's core** — today
   and through future Pi updates.

## References

- Zhang, A. L., Wei, D., Jang, L., & Madry, A. (2025). *Recursive Language
  Models.* MIT CSAIL. [arXiv:2512.24601](https://arxiv.org/abs/2512.24601)
