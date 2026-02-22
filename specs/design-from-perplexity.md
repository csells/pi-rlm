Below is an implementation blueprint that pulls together the MIT RLM design, the current RLM ecosystem, and the Pi extension/widget APIs, targeting a TypeScript-only implementation that plugs cleanly into the existing Pi TUI and avoids Pi’s built‑in compaction.

---

## 1. What you are actually building

Target:

- A **Pi extension package** (TypeScript) that:
  - Exposes **RLM as a “virtual model”**: a drop‑in replacement for `llm.completion` from Pi’s perspective.
  - Provides **tools and slash commands** (`/rlm`, `rlm_query` tool) for explicit user control.
  - Integrates with the **Pi TUI widget API** to show **RLM status above the editor** and optional overlays.
  - Hooks into **Pi’s extension events** so that:
    - The **Pi agent never has to do compaction** itself; and
    - Large context is handled in an **external RLM environment** (files, REPL state), not by stuffing it into the model context.
- All components in **TypeScript**:
  - RLM engine (REPL + recursive orchestration).
  - Extension glue (tools, event handlers).
  - Widgets / TUI integration.

High‑level topology:

- LLM provider(s) are accessed **through Pi’s `pi-ai` abstraction**, not directly.
- The **RLM engine** lives inside the extension as a library.
- The Pi agent delegates “long‑context” work to the RLM engine via tools and/or automatic routing, but its own message history stays small.

---

## 2. MIT RLM: key mechanics to mirror

The MIT paper and reference implementation set up RLMs as an **inference‑time scaffold** that replaces a plain `llm.completion(prompt, model)` call with `rlm.completion(prompt, model)`. [arxiv](https://arxiv.org/abs/2512.24601)

Core ideas to preserve:

1. **External environment REPL**
   - Long input (10M+ tokens in experiments) is stored **outside** the model, in an environment variable (e.g., `context`) inside a REPL. [arxiv](https://arxiv.org/abs/2512.24601)
   - The LLM issues **code** to:
     - Peek at slices of the context.
     - Grep, partition, search.
     - Spawn **recursive LM calls** on sub‑segments via a function like `llm_query(...)` or `RLM_SUBQUERY(...)`. [github](https://github.com/alexzhang13/rlm)

2. **Root vs sub‑LM roles**
   - Root LM:
     - Receives the user’s query and the API of the REPL environment.
     - Writes code that manipulates the external context and recursively calls sub‑LMs.
   - Sub‑LM:
     - Same or smaller model, called on smaller snippets, often in parallel. [arxiv](https://arxiv.org/html/2512.24601v1)

3. **Looping controller**
   - A host loop:
     - Prompts the root LM with the current REPL transcript and RLM instructions.
     - Parses out code to execute.
     - Executes it inside the REPL (incl. sub‑LM calls).
     - Feeds back outputs until a termination signal (`FINAL(...)` / equivalent) is produced. [github](https://github.com/alexzhang13/rlm)

4. **Performance characteristics**
   - Works **100x base context window** (10M+ tokens) with good quality and cost. [arxiv](https://arxiv.org/html/2512.24601v1)
   - Outperforms vanilla frontier models and naïve long‑context scaffolds (summarization + retrieval) especially on deep research, codebase understanding, and long‑horizon tasks. [arxiv](https://arxiv.org/html/2512.24601v2)

The official Python repo `alexzhang13/rlm` gives the structure to mirror in TS: `RLM` class, a REPL abstraction, LLM client wrapper, prompts, tracing. [github](https://github.com/alexzhang13/rlm)

---

## 3. Existing RLM implementations to mine for patterns

### 3.1 Official & community RLM engines

Relevant codebases:

- **alexzhang13/rlm & rlm-minimal (Python)** – canonical reference:
  - `RLM` class with `.completion()`.
  - `RLM_REPL` environment that stores context as variables and offers `llm_query()` for recursive calls. [github](https://github.com/alexzhang13/rlm)
- **fullstackwebdev/rlm_repl (Python)** – clean separation between:
  - RLM base class.
  - REPL environment.
  - Utilities for logging, prompts, and cost tracking. [github](https://github.com/fullstackwebdev/rlm_repl)
- **hampton-io/RLM (Node/TypeScript)** – TS implementation:
  - Node/TS RLM engine with **multi‑provider support** (OpenAI, Anthropic, Gemini, etc.).
  - JS REPL as environment, sandbox via `vm`.
  - Features: streaming, cost tracking, semantic chunking, recursive sub‑queries, tracing. [github](https://github.com/hampton-io/RLM)
- **rlm-go (Go)** – Go‑based REPL using Yaegi, shows that:
  - Embedding the interpreter eliminates IPC overhead.
  - Environment exposes `Query()` and `QueryBatched()` for sub‑calls and `FINAL()`/`FINAL_VAR()` for termination. [github](https://github.com/XiaoConstantine/rlm-go)

These show you can **cleanly separate**:

- LLM wrapper (provider‑agnostic).
- RLM controller (loop).
- Language‑specific REPL environment.

Your implementation can mirror that structure but use **TypeScript + Node VM / plain JS** instead of Python/Go.

### 3.2 RLM in Claude Code and coding agents

Several implementations embed RLM into coding agents:

- **brainqub3/claude_code_RLM**:
  - Root LM: Claude Code main conversation (e.g., Claude Opus).
  - Sub‑LM: a smaller model (Haiku) via a `rlm-subcall` agent/tool.
  - Environment: persistent Python REPL (`rlm_repl.py`) that stores large context and offers utilities. [github](https://github.com/brainqub3/claude_code_RLM)
- **rlm‑claude‑code** (DeepWiki summary):
  - Claude Code plugin that:
    - **Externalizes conversation/code context into Python variables**.
    - Uses a sandbox REPL where Claude writes code to explore, partition, search, and recursively subcall. [deepwiki](https://deepwiki.com/rand/rlm-claude-code)
    - Adds heuristics to decide **when to activate RLM** vs vanilla mode.
- **Tenobrus’ RLM skill analysis**:
  - Implements RLM as a “skill” inside Claude Code:
    - Uses **Bash** + filesystem as the environment instead of Python.
    - Treats files as variables and stores intermediate results in the filesystem.
    - Coding agent recursively calls itself over scoped subsets of files. [jangwook](https://jangwook.net/en/blog/en/rlm-recursive-language-model-coding-agent/)
- These systems enforce **structured protocols**: filter → index → map → reduce; limit how many files live in the root context; push the rest into recursive sub‑calls. [linkedin](https://www.linkedin.com/posts/hello-marc-green_if-you-want-to-try-an-rlm-version-of-claude-activity-7428894275700056064-x4r6)

This is close to what Pi needs: embed RLM as a **first‑class capability inside the agent environment**, instead of a separate microservice.

---

## 4. Pi coding agent: extension & widget model

Key facts (from the Pi site and ecosystem):

- **Pi is a CLI/TUI coding agent** built from packages like `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`. [nader.substack](https://nader.substack.com/p/how-to-build-a-custom-agent-framework)
- It is deliberately **minimal** but heavily extensible:
  - Tools, skills, prompt templates, themes.
  - **Extensions** are TS/JS modules that handle events, register tools, commands, and UI components (widgets, status lines, overlays). [github](https://github.com/qualisero/awesome-pi-agent)

### 4.1 Extension API shape

From Nader’s write‑up and existing extensions: [nader.substack](https://nader.substack.com/p/how-to-build-a-custom-agent-framework)

- An extension is typically:

```ts
// ~/.pi/agent/extensions/my-extension.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function myExtension(api: ExtensionAPI) {
  // event hooks, tools, widgets here
}
```

- **Event hooks** (partial list relevant to RLM):
  - `"before_agent_start"` – inject context or modify the prompt/system message before the agent loop starts. [nader.substack](https://nader.substack.com/p/how-to-build-a-custom-agent-framework)
  - `"context"` – rewrite the message array before each LLM call (drop or inject messages). [nader.substack](https://nader.substack.com/p/how-to-build-a-custom-agent-framework)
  - `"session_before_compact"` – customize or override the default **compaction/summarization** behavior. [nader.substack](https://nader.substack.com/p/how-to-build-a-custom-agent-framework)
  - `"session_start"` – good place to initialize widgets or extension state. [libraries](https://libraries.io/npm/@willyfrog%2Fagents-warning)
- **Tools**:
  - Defined with TypeBox schemas; tool handlers get `args` + a `ctx` object (cwd, file system helper, etc.). [docs.vers](https://docs.vers.sh/tutorials/pi-extensions)
  - Can **override built‑ins** (e.g., route `bash` to a VM via SSH). [docs.vers](https://docs.vers.sh/tutorials/pi-extensions)
- **Dynamic context**:
  - Extensions can inject or filter messages before a turn to implement **RAG, long‑term memory, or context pruning**. [shittycodingagent](https://shittycodingagent.ai)

### 4.2 Widgets & custom TUI

Pi exposes a rich TUI API via `@mariozechner/pi-tui`:

- Extensions can:
  - **Add widgets above or below the editor**, custom footers/status lines, overlays, or completely replace the editor UI. [npmjs](https://www.npmjs.com/package/@yochow%2Fpi)
  - Use TUI components like `Container`, `Text`, and helpers such as `matchesKey` to handle keyboard shortcuts. [libraries](https://libraries.io/npm/pi-skill-palette)
- Examples:
  - **agents-warning** extension:
    - On `session_start`, if no `AGENTS.md`/`CLAUDE.md` in cwd, shows an editor widget:
      - With id `agents-warning`
      - Placement `aboveEditor`. [libraries](https://libraries.io/npm/@willyfrog%2Fagents-warning)
  - **pi-skill-palette**:
    - Provides a `/skill` command.
    - Shows currently queued skill in **footer and widget** until consumed. [libraries](https://libraries.io/npm/pi-skill-palette)
  - **pi-manage-todo-list**:
    - Renders a live todo list **widget above the editor**, updated as the agent mutates the todo list via a tool. [github](https://github.com/tintinweb/pi-manage-todo-list)

This gives all the pieces necessary to:

- Attach **RLM runtime state** to a widget above the editor (phase, progress, current file).
- Offer commands like `/rlm` and overlays for configuration.

---

## 5. Architectural overview for “Pi RLM” extension

### 5.1 Components

1. **RLM Engine (TypeScript library)**
   - Pure TS module, no Pi coupling.
   - Provides `RlmEngine.completion()` as the replacement for `llm.completion`.
   - Encapsulates:
     - LLM client abstraction (backed by `pi-ai` for providers/models).
     - REPL environment for context manipulation and recursive calls.
     - Recursion and control loop.

2. **Pi RLM Extension (glue)**
   - Default export that receives `ExtensionAPI`.
   - Responsibilities:
     - Register **tools** (`rlm_query`, `rlm_index`, maybe `rlm_inspect`).
     - Register **slash commands** (`/rlm`, `/rlm status`).
     - Hook into:
       - `"before_agent_start"` – inject RLM protocol instructions/system cues.
       - `"context"` – prune large tool results and replace them with lightweight references.
       - `"session_before_compact"` – disable or neutralize Pi’s built‑in compaction.
     - Wire **RLM Engine** into Pi’s model stack (via `pi-ai`).

3. **RLM UI Layer (widgets + overlays)**
   - Uses `@mariozechner/pi-tui` to render:
     - **Above‑editor status widget**: “RLM: indexing 37/240 files (phase: map)” etc.
     - Optional **overlay** for `/rlm` configuration (select model, recursion depth, max cost).

4. **Storage / state**
   - Lightweight persistent store (e.g., JSONL or SQLite under `.pi/rlm/`) for:
     - RLM runs and traces.
     - Mappings from **stub IDs** used in Pi chat messages to actual blobs stored on disk.
   - In‑memory state for current active RLM run(s) per session.

### 5.2 Control flow (single RLM query via /rlm)

1. User runs `/rlm` in the Pi TUI:
   - Extension opens an overlay or uses inline prompt to get:
     - Query (what to answer).
     - Scope (e.g. “workspace”, subdirectory, or named context).
     - Options (model, recursionDepth, maxParallel, budget).

2. Extension constructs a **context handle**:
   - E.g. list of files, globs, or a pointer saying “workspace root at `<cwd>`”.
   - No file contents need to be loaded into Pi’s message history.

3. Extension calls `RlmEngine.completion(query, contextHandle, options)`.
   - This runs fully **outside** the Pi agent loop — as a background job from Pi’s perspective.
   - Engine streams progress updates back via a callback.

4. Pi RLM Extension:
   - Updates the **RLM status widget** with current phase and progress.
   - Eventually posts a final **assistant message** back into the chat once RLM finishes.

5. Pi’s session history sees:
   - A user `/rlm` command.
   - One or a few assistant messages (status + final answer).
   - **No multi‑MB context blobs**, so compaction is never forced.

---

## 6. RLM Engine design in TypeScript

This mirrors the MIT and Node implementations but uses `pi-ai` as the backing LLM client.

### 6.1 Core interfaces

```ts
// messages.ts
export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
  name?: string;
}

export interface CompletionOptions {
  maxTokens?: number;
  temperature?: number;
  // provider-specific options (thinking, reasoning model, etc.) can be added
}

export interface ChatCompletion {
  messages: ChatMessage[];
  // raw provider response for tracing, token usage etc.
}

export interface LlmClient {
  completion(
    messages: ChatMessage[],
    options: CompletionOptions,
  ): Promise<ChatCompletion>;
}
```

In the Pi environment, `LlmClient` should be backed by **`pi-ai`** so all provider logic is shared with the rest of Pi. [nader.substack](https://nader.substack.com/p/how-to-build-a-custom-agent-framework)

### 6.2 RLM environment abstraction

```ts
// rlm-env.ts
export interface RlmContextHandle {
  // e.g. rootPath of workspace, explicit file list, or opaque id
  id: string;
  description?: string;
}

export interface RlmEnvironment {
  readonly handle: RlmContextHandle;

  // Context probing primitives (implemented in TS, documented to the LM)
  peek(offset: number, length: number): Promise<string>;
  grep(pattern: string, options?: { maxHits?: number }): Promise<string[]>;
  listFiles(glob?: string): Promise<string[]>;

  // Sub-LLM calls
  llmQuery(prompt: string): Promise<string>;
  llmQueryBatched(prompts: string[]): Promise<string[]>;

  // Result finalization
  setFinalResult(result: string): void;
  hasFinalResult(): boolean;
  getFinalResult(): string | undefined;
}
```

Implementation notes:

- `peek`, `grep`, `listFiles` can be implemented using Node `fs` and (optionally) CLI tools like `rg` invoked via `child_process.execFile`.
- `llmQuery`/`llmQueryBatched` use the **same `LlmClient`** (possibly a different model id) but submit only small prompts.
- Security/isolation can be deferred as requested; in production, this environment would run in a sandbox.

### 6.3 RLM controller (loop)

A minimal controller:

````ts
// rlm-engine.ts
import { LlmClient, ChatMessage } from "./messages";
import { RlmEnvironment, RlmContextHandle } from "./rlm-env";

export interface RlmConfig {
  rootModel: string;
  subModel?: string;
  maxSteps: number;
  maxDepth: number;
}

export interface RlmProgress {
  step: number;
  phase: "plan" | "index" | "map" | "reduce" | "verify" | "done";
  detail?: string;
}

export interface RlmResult {
  answer: string;
  trace: unknown; // e.g. list of steps, code snippets, subcalls
}

export type ProgressCallback = (update: RlmProgress) => void;

export class RlmEngine {
  constructor(
    private readonly llm: LlmClient,
    private readonly config: RlmConfig,
  ) {}

  async completion(
    query: string,
    context: RlmContextHandle,
    onProgress?: ProgressCallback,
  ): Promise<RlmResult> {
    const env = this.createEnvironment(context);
    const transcript: ChatMessage[] = this.buildInitialTranscript(query, env);

    for (let step = 0; step < this.config.maxSteps; step++) {
      onProgress?.({ step, phase: "plan" });

      const completion = await this.llm.completion(transcript, {
        // map rootModel -> appropriate provider config in the LlmClient
      });

      const { nextTranscript, envUpdated } = await this.handleCompletionStep(
        completion,
        env,
      );

      transcript.push(...nextTranscript);

      if (envUpdated && env.hasFinalResult()) {
        onProgress?.({ step, phase: "done" });
        return { answer: env.getFinalResult()!, trace: { steps: step } };
      }
    }

    throw new Error("RLM exceeded maxSteps without producing a FINAL result");
  }

  private createEnvironment(context: RlmContextHandle): RlmEnvironment {
    // Construct a concrete environment that wraps fs, grep, etc.
    // and provides llmQuery via this.llm with different options.
    // (Details depend on how aggressive you want recursion.)
    throw new Error("not implemented");
  }

  private buildInitialTranscript(
    query: string,
    env: RlmEnvironment,
  ): ChatMessage[] {
    const systemInstructions = this.buildSystemPrompt(env);
    return [
      { role: "system", content: systemInstructions },
      { role: "user", content: query },
    ];
  }

  private buildSystemPrompt(env: RlmEnvironment): string {
    // Encode the RLM protocol for root LM:
    // - Document env API: peek, grep, listFiles, llmQuery, FINAL
    // - Give examples of map / reduce / recursive strategies (from paper)
    return "You are a Recursive Language Model. You have access to...";
  }

  private async handleCompletionStep(
    completion: ChatCompletion,
    env: RlmEnvironment,
  ): Promise<{ nextTranscript: ChatMessage[]; envUpdated: boolean }> {
    // 1. Parse completion.messages[completion.messages.length-1].content
    // 2. Extract code segments (e.g. fenced ```js ... ``` blocks or special markers)
    // 3. Execute them in the JS REPL bound to env
    // 4. Capture stdout/stderr, any env.setFinalResult() calls
    // 5. Return new assistant + tool messages for the transcript
    throw new Error("not implemented");
  }
}
````

This is intentionally high‑level; details like code extraction and REPL can follow patterns from `alexzhang13/rlm-minimal` and `hampton-io/RLM`. [github](https://github.com/alexzhang13/rlm-minimal)

---

## 7. Wiring RLM into Pi via an extension

### 7.1 Extension skeleton

```ts
// ~/.pi/agent/extensions/pi-rlm.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { RlmEngine, RlmConfig } from "./rlm-engine";
import { createPiLlmClient } from "./pi-llm-client";
import { createRlmStatusStore } from "./rlm-status";

export default function piRlmExtension(api: ExtensionAPI) {
  const llmClient = createPiLlmClient(api);
  const config: RlmConfig = {
    rootModel: "current", // resolve via session.model
    subModel: "current",
    maxSteps: 64,
    maxDepth: 2,
  };
  const engine = new RlmEngine(llmClient, config);
  const statusStore = createRlmStatusStore(api);

  registerRlmTools(api, engine, statusStore);
  registerRlmCommands(api, engine, statusStore);
  registerRlmContextHooks(api);
  registerRlmCompactionHooks(api);
  registerRlmWidgets(api, statusStore);
}
```

Sub‑sections below fill in the responsibilities.

### 7.2 LLM client backed by pi‑ai

`createPiLlmClient` should wrap `pi-ai` so you get:

- Multi‑provider support.
- Streaming and tool‑call compatibility.
- Thinking / reasoning modes when using models that support it. [nader.substack](https://nader.substack.com/p/how-to-build-a-custom-agent-framework)

Conceptually:

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type {
  LlmClient,
  ChatMessage,
  CompletionOptions,
  ChatCompletion,
} from "./messages";

export function createPiLlmClient(api: ExtensionAPI): LlmClient {
  return {
    async completion(
      messages: ChatMessage[],
      options: CompletionOptions,
    ): Promise<ChatCompletion> {
      // Use whatever hook the ExtensionAPI exposes to call the underlying model,
      // or re-use pi-ai directly if available in the environment.
      // The key is to honor the same provider/model config as the active Pi session.
      throw new Error("Wire this to pi-ai or the session model client");
    },
  };
}
```

This keeps provider‑specific logic centralized with the rest of Pi.

### 7.3 Tools for explicit RLM use

Define, at minimum, a tool that the LLM (and you, via commands) can call:

```ts
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { RlmEngine } from "./rlm-engine";
import type { RlmStatusStore } from "./rlm-status";

export function registerRlmTools(
  api: ExtensionAPI,
  engine: RlmEngine,
  statusStore: RlmStatusStore,
) {
  api.registerTool({
    name: "rlm_query",
    description:
      "Run a Recursive Language Model query over the current project",
    schema: Type.Object({
      query: Type.String(),
      scope: Type.Optional(Type.String()), // e.g. path or logical scope
    }),
    async handler(args, ctx) {
      const scope = args.scope ?? ctx.cwd;
      const contextHandle = { id: scope, description: `Workspace at ${scope}` };

      statusStore.beginRun({ query: args.query, scope });

      const result = await engine.completion(
        args.query,
        contextHandle,
        (progress) => {
          statusStore.update(progress);
        },
      );

      statusStore.finishRun(result);

      return {
        answer: result.answer,
        // Optionally: a handle to a stored trace on disk
      };
    },
  });
}
```

This `rlm_query` tool can be:

- Called explicitly by users via `/tool rlm_query {...}` or a slash command wrapper.
- Recommended to the model via system instructions injected by the extension when the context is too large.

### 7.4 Slash commands and user‑facing entry points

You can add commands like `/rlm`, `/rlm status`, and `/rlm cancel`, wired to the extension and status store. The exact command registration API depends on Pi’s command system, but existing packages (e.g., `pi-manage-todo-list`, `pi-skill-palette`) show patterns where extensions define commands and their behavior. [github](https://github.com/tintinweb/pi-manage-todo-list)

Intended UX:

- `/rlm` – prompts for query and triggers `rlm_query`.
- `/rlm status` – toggles or focuses the RLM widget overlay.
- `/rlm cancel` – cancels the current RLM run (cancels underlying LLM calls / marks run aborted).

---

## 8. Making Pi “RLM‑native” and avoiding compaction

Pi already has:

- **Auto‑compaction** of old messages when approaching context limit. [shittycodingagent](https://shittycodingagent.ai)
- A **`session_before_compact`** event to customize this process. [nader.substack](https://nader.substack.com/p/how-to-build-a-custom-agent-framework)
- A **`context`** event to filter or inject messages every turn. [nader.substack](https://nader.substack.com/p/how-to-build-a-custom-agent-framework)

The goal is to **make compaction effectively unnecessary** by keeping the conversation small and by explicitly disabling Pi’s own compaction.

### 8.1 Context pruning via `context` event

Strategy:

- Keep:
  - System prompts.
  - Recent user and assistant messages.
  - Short tool results.
- Replace:
  - Large `toolResult` blobs (e.g., multi‑KB file contents) with:
    - A small reference message (“[rlm-context: file src/foo.ts stored as ctx‑1234]”).
    - And store the actual blob in your RLM state (file on disk or DB).

Example shape:

```ts
function registerRlmContextHooks(api: ExtensionAPI) {
  api.on("context", (event, ctx) => {
    const MAX_TOOL_RESULT_CHARS = 2_000;

    const prunedMessages = event.messages.map((msg) => {
      if (msg.role !== "toolResult") return msg;

      if (msg.content.length <= MAX_TOOL_RESULT_CHARS) return msg;

      // Store the full content elsewhere and replace with stub.
      const id = storeLargeToolResult(msg, ctx); // your implementation
      return {
        ...msg,
        content: `[rlm-stub:${id}]`, // tiny placeholder
      };
    });

    return { ...event, messages: prunedMessages };
  });
}
```

This mirrors what some Pi extensions (e.g., context filters and usage dashboards) already do: edit the context right before the LLM sees it. [libraries](https://libraries.io/npm/pi-context-filter)

### 8.2 Disabling or overriding compaction

Use `session_before_compact` to effectively turn off compaction:

```ts
function registerRlmCompactionHooks(api: ExtensionAPI) {
  api.on("session_before_compact", (event, ctx) => {
    // Implementation detail depends on the actual event contract,
    // but conceptually you want to:
    // - keep messages unchanged
    // - signal that compaction is not needed / has been handled.

    // Pseudo-code:
    return {
      ...event,
      messages: event.messages,
      // if there is a flag to indicate "already compacted", set it
      // didCompact: false,
    };
  });
}
```

Even if there is no direct “disable” flag, you can push Pi’s compaction threshold far away in configuration and use this hook to enforce a “no‑op” summarization.

With RLM:

- All heavy context is in the RLM environment (filesystem, REPL state), not the chat history.
- The Pi session remains small (mostly instructions + high‑level summaries), so even if compaction ran, there is little to compact.

---

## 9. RLM status widget and TUI integration

Use the same patterns as `agents-warning`, `pi-manage-todo-list`, and `pi-skill-palette`: [libraries](https://libraries.io/npm/@willyfrog%2Fagents-warning)

- **Where**: editor widget with placement `aboveEditor`.
- **What**: current RLM run:
  - State: idle / indexing / mapping / reducing / verifying / done / error.
  - Progress: `filesProcessed / totalFiles`, or `steps / maxSteps`.
  - Active query short summary.
- **Interaction**:
  - Key hints: `[c]ancel`, `[o]pen overlay`, etc.
  - Toggled via `/rlm` or a key chord.

Conceptual status store:

```ts
// rlm-status.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { RlmProgress, RlmResult } from "./rlm-engine";

export interface RlmRunState {
  id: string;
  query: string;
  scope: string;
  phase: RlmProgress["phase"];
  step: number;
  error?: string;
  done: boolean;
}

export interface RlmStatusStore {
  beginRun(meta: { query: string; scope: string }): void;
  update(progress: RlmProgress): void;
  finishRun(result: RlmResult): void;
  getState(): RlmRunState | null;
}

export function createRlmStatusStore(api: ExtensionAPI): RlmStatusStore {
  let state: RlmRunState | null = null;

  function notifyUi() {
    // trigger widget re-render; details depend on widget API
  }

  return {
    beginRun({ query, scope }) {
      state = {
        id: `${Date.now()}`,
        query,
        scope,
        phase: "plan",
        step: 0,
        done: false,
      };
      notifyUi();
    },
    update(progress) {
      if (!state) return;
      state = { ...state, phase: progress.phase, step: progress.step };
      notifyUi();
    },
    finishRun(_result) {
      if (!state) return;
      state = { ...state, done: true };
      notifyUi();
    },
    getState() {
      return state;
    },
  };
}
```

Widget registration (conceptual):

```ts
function registerRlmWidgets(api: ExtensionAPI, statusStore: RlmStatusStore) {
  if (!api.hasUI) return;

  api.registerWidget({
    id: "rlm-status",
    placement: "aboveEditor", // matches patterns from agents-warning etc.[cite:68]
    render(props) {
      const state = statusStore.getState();
      if (!state) return null;

      const { Container, Text } = require("@mariozechner/pi-tui");

      return (
        <Container>
          <Text color="cyan">
            {`RLM [${state.phase}] step ${state.step} — ${state.query}`}
          </Text>
        </Container>
      );
    },
  });
}
```

Adapt to the actual widget registration API (exact function names may differ, but the pattern follows existing extensions that declare widgets with id + placement + render function).

---

## 10. How this compares to Claude Code RLM patterns

Your Pi RLM extension will be structurally very similar to Claude Code RLM implementations:

- **Context externalization**:
  - In Claude Code: Python REPL + MCP or Bash environment that stores large code/logs as variables/files. [deepwiki](https://deepwiki.com/rand/rlm-claude-code)
  - In Pi: Node/TS REPL + filesystem; context stored under `.pi/rlm/` or workspace root; referenced by stubs in chat.

- **Decision policy**:
  - Claude Code: classify tasks and only activate RLM for large/complex ones. [deepwiki](https://deepwiki.com/rand/rlm-claude-code)
  - Pi: can do the same—e.g., in `before_agent_start`, inject into system prompt that the model should:
    - Prefer direct tools for small contexts.
    - Use `rlm_query` tool when asked to work with “entire repo” / “all logs” etc.

- **UI & telemetry**:
  - Claude Code RLM skills often add status/logging output and traces.
  - Pi: RLM widget + possible HTML export of traces (leveraging Pi’s existing export paths). [shittycodingagent](https://shittycodingagent.ai)

The main difference is that **Pi gives you a first‑class TUI and extension runtime in TypeScript**, so you do not need extra Python services unless you want them.

---

## 11. Implementation roadmap

A pragmatic phased rollout:

### Phase 1 – Minimal, manual RLM

- Implement `RlmEngine` with:
  - Single recursion depth.
  - Basic JS REPL (no advanced sandbox).
  - `peek`, `grep`, `listFiles`, `llmQuery`.
- Implement Pi extension that:
  - Registers `rlm_query` tool.
  - Adds `/rlm` slash command (no automatic routing).
  - Shows a simple status widget (“RLM: running / done”).

### Phase 2 – Protocol & integration

- Enrich RLM system prompt with:
  - Examples from MIT paper (map‑reduce, recursive search). [arxiv](https://arxiv.org/html/2512.24601v1)
  - Guardrails for when to spawn sub‑calls (semantic tasks vs regex tasks). [arxiv](https://arxiv.org/html/2512.24601v2)
- Add:
  - `context` hooks to prune large tool results.
  - `session_before_compact` no‑op compaction.
- Allow configuring root and sub models per session (e.g. Pi’s `/model` + extension config).

### Phase 3 – Automatic activation and ergonomics

- Add heuristics or explicit mode:
  - `/rlm on` – RLM‑first mode; extension rewrites certain user requests to `rlm_query`.
  - `/rlm off` – classic Pi behavior.
- Expose more detailed overlays:
  - History of RLM runs.
  - Inspect traces (map/reduce phases, subcalls).

---

## 12. Summary

- The MIT RLM framework treats long context as an **external environment**, letting the LM programmatically **peek, search, partition, and recursively call itself** instead of stuffing everything into a single context window. [arxiv](https://arxiv.org/abs/2512.24601)
- Existing implementations in Python, Go, Node/TS, and Claude Code plugins show that an RLM system naturally decomposes into:
  - LLM client.
  - REPL environment.
  - Recursive controller loop.
- Pi’s extension APIs (events like `context`, `before_agent_start`, `session_before_compact`) and widget system (`aboveEditor` widgets, overlays) are a good fit for RLM:
  - Heavy context can be stored externally and referenced by stubs.
  - Pi’s **own compaction can be neutralized**, and is rarely needed because the chat history stays small.
  - Users can control RLM through `/rlm` and see progress inline in the existing TUI.

This architecture gives you an RLM‑native Pi agent, implemented purely in TypeScript, that can work over arbitrarily large workspaces and logs while keeping Pi’s core session small and free of compaction pressure.
