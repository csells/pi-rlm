Love this direction. This is exactly the kind of thing Pi is weirdly well-suited for if you do it as an extension instead of a fork.

I did the research sweep, and the short version is: your plan is solid, there are already a couple of “RLM for coding agent” experiments in the wild (including one explicitly built on Pi), and Pi’s TypeScript extension/UI APIs are good enough to build a first-class RLM mode inside the existing TUI without making users leave the normal workflow. The key move is to make RLM an _external context runtime_ plus _recursive sub-call tool_, and then use Pi widgets to expose the state so it doesn’t feel like magic. ([arXiv][1])

Here’s the architecture I’d recommend.

First, the paper itself. MIT’s RLM paper defines the core pattern very clearly: instead of stuffing a giant prompt into the model context, you load the long prompt into an external environment (their canonical example is a Python REPL variable), let the model programmatically inspect and decompose it, and allow recursive self-calls over snippets. They explicitly call out context compaction as insufficient for dense-access tasks, which is exactly aligned with your goal of “Pi should never have to compact.” They also compare against summary/compaction agents and retrieval agents, and show strong gains on hard long-context tasks. ([arXiv][1])

Now the practical part: Pi.

Pi’s extension system is TypeScript-based, and extensions can subscribe to lifecycle events, register LLM-callable tools, register commands/shortcuts/flags, and interact with the TUI via UI primitives. The UI context supports `setWidget(...)` (above/below editor), notifications, status text, custom overlays, custom footer/header, etc. Pi also exposes session/compaction events, including `session_before_compact` (which can be intercepted) and context events before LLM calls. That gives you the hooks you need to implement RLM mode _without modifying core Pi_. ([GitHub][2])

There are also relevant existing implementations:

- The official MIT `rlm` repo is Python and ships the inference engine + REPL environments + trajectory logging/visualizer. It’s the reference semantics, not the implementation language you want. ([GitHub][3])
- `ypi` is a recent Pi-based recursive coding agent that takes the “Pi already has a bash REPL” route and adds an `rlm_query` function plus prompting; it explicitly describes itself as “Pi that can call itself.” That’s super useful as a design signal, even if you want a tighter TypeScript extension integration. ([GitHub][4])
- For Claude Code, there are multiple community RLM projects/specs (including `rlm-claude-code`) and Anthropic’s official extension surface is mostly skills/plugins/hooks/MCP, not a rich in-process widget API like Pi’s. So Claude Code is a useful comparison target, but Pi is actually the better host for a polished in-TUI RLM UX. ([GitHub][5])

So the design I’d build is this:

You make a Pi extension called something like `pi-rlm` in TypeScript. It provides an “RLM mode” that wraps normal Pi interaction with three layers:

1. an external context store (instead of relying on huge chat history),
2. a recursive query tool callable by the model,
3. a TUI widget layer to show recursion state, budget, and context objects.

The killer trick is that you do **not** try to reimplement Pi’s whole agent loop. You let Pi stay the agent. Your extension adds tools + context orchestration + UI, and intercepts compaction so the session is externalized before compaction is needed.

### Core components (TypeScript)

**1) RLM Context Runtime (extension-local)**
This is the heart of it. Think of it as the TypeScript version of the paper’s REPL variable environment.

It manages “externalized” context objects like:

- `conversation` (structured message history)
- `files` (path -> content, lazily loaded/cached)
- `toolOutputs` (captured outputs, chunked)
- `scratch` / `workingMemory`
- `artifacts` (intermediate summaries, extracted facts, code maps)
- `stats` (estimated tokens, chunk counts, recursion depth)

Important: this runtime is _not_ the model context. It’s your extension-owned state in memory + on disk (JSONL/SQLite/files).

I’d persist it under something like:
`~/.pi/rlm/<session-id>/`
with:

- `context/` chunk files
- `index.json` metadata
- `calls.jsonl` trajectory
- `snapshots/` optional

This gives you resumability and auditing.

**2) RLM Tools (registered with Pi extension API)**
Register LLM-callable tools that mirror the paper’s primitives, but in TypeScript and tailored for coding-agent tasks.

At minimum:

- `rlm_peek` — get slices/snippets from a context object
- `rlm_search` — regex/text search across context objects or files
- `rlm_chunk` — produce deterministic chunks for a large object
- `rlm_query` — recursive sub-call over a selected chunk/object
- `rlm_extract` — extract structured facts into `scratch`
- `rlm_merge` — combine child outputs into parent result
- `rlm_context_stats` — inspect token/size estimates
- `rlm_checkpoint` — persist current runtime state

The model sees these as tools, same as Pi’s built-ins, but the actual heavy lifting is in your extension.

**3) Recursive Call Engine**
This is where most implementations get sloppy. Don’t make the root model “call itself” abstractly; make it call a deterministic sub-runner.

`rlm_query(...)` should:

- create a child call frame (depth, parent call ID, budget slice)
- materialize a child context object (or object references)
- invoke a **child Pi run** in non-interactive mode (or use Pi’s lower-level API if available in-process)
- give it a minimal RLM system prompt and tool allowlist
- capture result + tool trace
- return a compact structured result to the parent

Use the same TypeScript codepath for root and child orchestration, with different config (depth, model, permissions, budget).

This mirrors the paper’s self-similarity and avoids special “planner/scout” agents. ([arXiv][1])

**4) Context Externalizer / Compaction Interceptor**
This is the “never compact” piece.

Use Pi’s session/context events to watch context growth and proactively externalize:

- On message submit / tool result: append to runtime store
- On `context` event before LLM call: replace large historical content with a compact RLM descriptor (counts, object names, stats, not raw text)
- On `session_before_compact`: cancel or short-circuit compaction and instead run your externalization/checkpoint flow

Pi’s extension types show both `getContextUsage()` and `session_before_compact` hooks, which is exactly what you want. ([GitHub][2])

The root prompt then says, in effect:
“Your full context is in RLM objects. Use `rlm_peek/search/query` instead of asking for dumps.”

That’s the paper pattern, just implemented inside Pi.

**5) TUI Widgets (Pi UI API)**
This is where Pi beats Claude Code for this use case.

Use `ctx.ui.setWidget(...)` to show an always-on RLM panel above or below the editor:

- RLM mode: ON/OFF
- Depth / active recursive calls
- Estimated externalized tokens
- Current object counts (`conversation`, `files`, `toolOutputs`)
- Spend / time / call count
- Last child call status
- “Why not compacting?” badge (“RLM externalization active”)

Add an overlay (`ctx.ui.custom(...)`) for a richer “RLM Inspector”:

- call tree
- per-call prompt summary
- child results
- chunk previews
- trajectory logs
- quick actions (open object, replay child, pin fact)

This keeps the existing Pi TUI workflow, just with an extra cockpit instead of a separate app. ([GitHub][2])

### Recommended technical design (TypeScript-first)

I’d structure the extension like this:

- `src/index.ts` — extension entrypoint, registers tools/commands/events/widgets
- `src/runtime/RlmRuntime.ts` — context store, object registry, persistence
- `src/runtime/ObjectStore.ts` — chunking, indexing, serialization
- `src/runtime/TokenEstimator.ts` — rough token counts (doesn’t need exactness)
- `src/engine/RecursiveCallEngine.ts` — child call orchestration
- `src/engine/PiChildRunner.ts` — launches child Pi processes / SDK runs
- `src/tools/*.ts` — `rlm_peek`, `rlm_search`, `rlm_query`, etc.
- `src/ui/RlmWidget.ts` — small persistent widget
- `src/ui/RlmInspector.ts` — overlay inspector
- `src/prompt/RlmSystemPrompt.ts` — prompt templates and tool usage rules
- `src/events/*.ts` — compaction interception, context externalization hooks
- `src/tracing/TrajectoryLogger.ts` — JSONL call traces
- `src/config.ts` — per-session and user config

### Root prompt design (important)

Keep the root prompt tiny and procedural. The community Claude Code specs got this part mostly right: list available variables/objects, expose helper actions, forbid context dumps, and require final answers only when confident. You should do the same in Pi, but with your tool names. ([GitHub][5])

The root should know:

- what objects exist
- sizes and estimated token counts
- available tools
- recursion depth + limits
- output contract (final answer vs code changes vs plan)

That’s it. No giant session replay.

### Child call design

Children should run with:

- smaller/cheaper model by default
- limited depth
- narrower object visibility
- a strict “return structured findings” schema

The paper used a stronger root model and cheaper recursive model in at least one setup (GPT-5 root with GPT-5-mini recursive), and you should copy that pattern conceptually via Pi model config routing. ([arXiv][1])

### Pi-specific UX commands

Register slash commands (via extension command registration) for user control:

- `/rlm on`
- `/rlm off`
- `/rlm status`
- `/rlm inspect`
- `/rlm pin <selection>` (store selected text into external object)
- `/rlm export-trace`

And a toggle hotkey to show/hide the widget.

### How this compares to Claude Code implementations

Claude Code can absolutely host RLM-ish behavior via skills + MCP + hooks, and there are community repos doing exactly that. Anthropic’s docs support MCP servers, skills, hooks, and plugins, which is enough to build a workable RLM toolchain. But the in-terminal UX is more fragmented (skills/hooks/MCP are powerful but not the same as Pi’s in-process widget/custom TUI component APIs). Pi gives you a more cohesive extension story for this exact use case. ([Claude API Docs][6])

### Implementation strategy (practical)

I’d build this in three phases:

Phase 1: “RLM-lite” inside Pi

- externalize context objects
- implement `rlm_peek`, `rlm_search`, `rlm_context_stats`
- widget panel
- compaction interception with fallback message
- no recursion yet

This gets the “no compaction” behavior started and proves the object model.

Phase 2: true recursive calls

- implement `rlm_query`
- child runner via non-interactive Pi invocation (or SDK)
- trajectory logging
- recursive call tree UI

Now you’ve got the real paper pattern.

Phase 3: coding-agent optimizations

- file-aware chunking and symbol maps
- diff-aware object updates
- model routing (cheap child / stronger root)
- object pinning and fact caches
- replay/debug tools

### One sharp edge to plan for

The paper’s reference implementation uses Python REPL semantics. You want TypeScript everywhere (which is a great choice for your project overhead), so don’t imitate Python literally. Instead of “code in a REPL variable,” expose a **tool-first programmable object environment** in TS:

- deterministic tools (peek/search/chunk/query)
- structured object handles
- optional mini expression evaluator if needed later

That avoids embedding a JS REPL inside the agent (which is cool but gets messy fast) and still preserves the paper’s key idea: _the model manipulates context symbolically instead of carrying it in tokens_.

### My recommendation in one line

Build `pi-rlm` as a TypeScript Pi extension that externalizes session context into an extension-owned object store, exposes RLM primitives as Pi tools (especially `rlm_query` for recursive subcalls), intercepts compaction events, and uses Pi widgets/overlays to make recursion state visible inside the existing TUI.

That gives you the paper’s advantages, keeps Pi as the host agent, and avoids the “Claude Code giant context turns into soup” problem the RLM community keeps running into. MIT gives the theory, Pi gives the UX, and TypeScript keeps your brain from context-switching itself to death. ([arXiv][1])

If you want to push this from design into build-ready, the next best artifact is a concrete extension skeleton (TypeScript interfaces, tool schemas, event handlers, and widget component stubs) that matches Pi’s extension API exactly.

[1]: https://arxiv.org/html/2512.24601v1 "Recursive Language Models"
[2]: https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/src/core/extensions/types.ts "raw.githubusercontent.com"
[3]: https://raw.githubusercontent.com/alexzhang13/rlm/main/README.md "raw.githubusercontent.com"
[4]: https://raw.githubusercontent.com/rawwerks/ypi/master/README.md "raw.githubusercontent.com"
[5]: https://raw.githubusercontent.com/rand/rlm-claude-code/main/rlm-claude-code-spec.md "raw.githubusercontent.com"
[6]: https://docs.anthropic.com/en/docs/claude-code/mcp?utm_source=chatgpt.com "Connect Claude Code to tools via MCP"
