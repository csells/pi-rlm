/**
 * System prompt builders for Pi-RLM.
 * Per §9 of the design spec.
 */

import { RlmConfig } from "./types.js";

/**
 * Build the root system prompt injected in before_agent_start.
 * Manifest is injected separately in the context handler.
 */
export function buildSystemPrompt(_config: RlmConfig): string {
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

/**
 * Build the child-call system prompt for recursive analysis.
 */
export function buildChildSystemPrompt(
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
