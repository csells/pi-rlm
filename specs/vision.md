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

This isn't a niche problem. Any developer who runs complex, long-horizon coding
agent sessions — multi-file refactors, codebase audits, deep debugging — sees
auto-compaction fire routinely. For these users, compaction isn't an edge case.
It's the normal state of every working session, and the information loss
accumulates with every trigger.

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

   This recovery can fail. The agent might retrieve the wrong chunk, or miss
   the relevant context entirely. This is a real risk, and in some ways worse
   than compaction — with compaction, the model knows it lost information; with
   a bad retrieval, it might not. The manifest mitigates this by giving the
   model a structural map of what exists, but retrieval quality depends on the
   model's skill as an RLM strategist. The "Assumptions and Risks" section
   addresses this dependency directly.

5. **Full observability and full control.** The RLM blanket is transparent, not
   opaque. Recursive sub-calls are not a black box. Observability is
   **progressive**: by default, the user sees only RLM tool calls inline in the
   chat — same as any other tool. A TUI widget showing RLM state (mode, phase,
   recursion depth, token budget) appears only when RLM is actively processing
   and hides when idle. For users who want more, an inspector overlay
   visualizes the full call tree in real time, and every recursive invocation
   is logged to a trajectory file for post-hoc debugging and auditing. The
   depth of visibility matches the user's curiosity — from "just works" to
   full X-ray.

   Beyond observability, the user has **control**. They can adjust recursion
   depth, switch the model used for sub-calls, set budget limits, and cancel a
   recursive decomposition mid-flight. These are the same parameters the MIT
   paper used in its experiments (depth, model routing, budget), surfaced as
   user-facing controls rather than hidden configuration. The user can steer
   the RLM as precisely or as loosely as they want.

   **Cost visibility** is part of control. Recursive operations involve multiple
   LLM calls, and users paying their own API bills need to see what an
   operation will cost before it runs. Estimated token usage and cost should be
   surfaced before expensive operations, not discovered after the fact.

   **Graceful degradation** is part of control. If the RLM gets stuck —
   over-recursing, retrieving wrong context, spiraling on a bad decomposition —
   the user can cancel mid-flight and fall back to vanilla Pi behavior. The
   working context is never corrupted by a failed RLM operation. The extension
   can also be disabled entirely mid-session, reverting to standard Pi with
   compaction. The system fails safe.

6. **Security is external.** Pi-RLM does not implement sandboxing, OS-level
   isolation, or code execution guardrails. Those concerns are handled by the
   host environment (containers, sandboxes, infrastructure policy). This keeps
   the extension focused on what it does best: context management and recursive
   orchestration.

## What This Enables

Consider a concrete scenario. You're two hours into debugging a distributed
system failure. You've read stack traces from four services, examined config
files, traced request flows, and narrowed the root cause to a race condition
between two microservices. You ask: "What was the error code from the auth
service?" With vanilla Pi, auto-compaction fired an hour ago. The stack traces
from the first two services are gone — summarized into "investigated auth and
gateway services." The agent says it doesn't have that information. You re-read
the file manually, re-explain the context, and lose ten minutes.

With Pi-RLM, the agent fires an `rlm_search`, finds the exact stack trace in
the external store, and answers in seconds. You never broke stride.

That's the small version. The large version:

- **Whole-codebase operations.** "Audit all 500 files in src/ for race
  conditions" becomes tractable. The model writes a decomposition strategy,
  dispatches recursive queries to a fast sub-model, and synthesizes findings.
  The paper demonstrated RLMs outperforming both vanilla long-context models
  and conventional scaffolds on exactly these tasks.

- **Sessions that never degrade.** Auto-compaction never fires. The working
  context stays naturally small — not because information was discarded, but
  because it was externalized and remains accessible. The paper demonstrated
  reliable operation over 10M+ tokens.

- **Session resume with full context.** Because the external store persists,
  closing Pi and reopening tomorrow doesn't mean starting over. The agent can
  recover full context from the store — not a compacted summary of yesterday's
  session, but the actual data. Every session picks up where the last one left
  off.

- **Latency-for-depth trade-off.** RLM operations involve multiple LLM calls
  and take longer than a single-pass response. The payoff: they *work* on tasks
  that single-pass calls cannot handle. Recursive sub-calls route to cheaper,
  faster models and parallelize to control cost and wall-clock time. The paper
  demonstrated Pareto-efficient economics: superior depth at a fraction of
  frontier-model pricing.

- **Full auditability.** Every recursive call — its query, context slice, model,
  result, token usage — is logged. You can replay and debug the agent's entire
  reasoning process after the fact.

## What This Is Not

- **Not a RAG system.** There is no embedding index, no vector similarity
  search, no retrieval pipeline. The model programmatically explores
  externalized data using the RLM paper's mechanisms — code, not statistical
  similarity. The paper benchmarks against RAG-style approaches and
  demonstrates superior results. This also means Pi-RLM is not a structured
  retrieval or conversation indexing system — it uses the model's own
  decomposition intelligence, not pre-built query patterns over a conversation
  graph.

- **Not a replacement for Pi's agent.** Pi remains the agent. Pi-RLM augments
  it with context management and recursive capabilities. Everything runs
  in-process as a standard Pi extension — no forks, no standalone services, no
  external runtimes.

## Assumptions and Risks

**Risk 1: The generalization gap.** The MIT paper demonstrated RLMs on batch
analytical tasks — processing large corpora, codebase understanding, research
synthesis. These are tasks where you have a large blob of data and need to
extract structured answers. A coding agent session is fundamentally different:
interactive, stateful, incremental, and heterogeneous — a mix of user prompts,
code, tool outputs, errors, and model reasoning. The paper provides strong
evidence that the mechanism works; the risk is in generalizing from controlled
experiments on specific task types to the open-ended, unpredictable environment
of a real coding session. This is the central technical risk of the project.

**Risk 2: Model competence as RLM strategist.** The architecture depends on the
LLM knowing when to use RLM tools vs. normal Pi tools, writing effective
decomposition strategies, producing focused recursive sub-queries, and
synthesizing results from multiple children into coherent answers. If the model
is a poor strategist — over-recursing on simple questions, under-recursing on
complex ones, choosing the wrong tool — the system degrades to a slower, more
expensive version of normal Pi. Not all models are equally capable RLM
strategists; the extension may need to adapt its behavior based on model
capability.

**Risk 3: Externalization timing.** When does content move from working context
to external store? Too early and short sessions pay a retrieval tax for content
that would have fit in context. Too late and compaction fires before
externalization kicks in, defeating the purpose. The heuristics for when to
externalize are arguably the hardest design problem in the system, and getting
them wrong in either direction degrades the experience.

**Risk 4: Extension API surface.** The "pure Pi extension" constraint (Principle
3) requires that Pi's extension API supports prompt interception, child LLM
calls from extension code, and conversation history management. If any of these
require core changes to Pi, the constraint fails. An early feasibility audit
against Pi's actual API is essential before committing to detailed design.

The model is as much a user of this system as the human is. The quality of the
experience — for both — depends on how well the model understands its RLM
environment: what's externalized, what tools are available, when to use them,
and what they cost in latency and tokens. The paper solved this with carefully
designed environment descriptions and prompts. **The model's understanding of
its RLM environment is a first-class design concern**, not an afterthought.
The design doc must specify the strategy for model education: what the
environment description looks like, how the manifest is presented, and how
the model learns the cost/benefit of RLM operations.

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
