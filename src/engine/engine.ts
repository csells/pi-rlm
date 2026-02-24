/**
 * RecursiveEngine: Spawns and manages child LLM calls.
 * Per §6 of the design spec.
 */

import { randomBytes } from "node:crypto";
import { CallTree } from "./call-tree.js";
import { ConcurrencyLimiter } from "./concurrency.js";
import { CostEstimator } from "./cost.js";
import {
  ChildCallResult,
  ExtensionContext,
  IExternalStore,
  ITrajectoryLogger,
  IWarmTracker,
  Model,
  RlmConfig,
  SearchMatch,
} from "../types.js";
import { buildChildSystemPrompt } from "../system-prompt.js";
import { parsePattern, searchWithWorkerTimeout } from "../tools/search.js";

// ============================================================================
// Helper Types
// ============================================================================

interface Message {
  role: "user" | "assistant" | "toolResult" | "system";
  content: string | Array<{ type: string; text?: string }>;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface TextContent {
  type: "text";
  text: string;
}

interface AssistantMessage {
  role: "assistant";
  content: Array<TextContent | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }>;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

// ============================================================================
// Public Helper Functions
// ============================================================================

/**
 * Resolve the child model to use for a recursive call.
 * Per §6.2.
 */
export function resolveChildModel(
  modelOverride: string | undefined,
  config: RlmConfig,
  ctx: ExtensionContext,
): Model | null {
  const modelStr = modelOverride ?? config.childModel;
  if (modelStr && ctx.modelRegistry) {
    const [provider, ...idParts] = modelStr.split("/");
    const id = idParts.join("/");
    const found = ctx.modelRegistry.find(provider, id);
    if (found) return found;
    console.warn(`[pi-rlm] Child model "${modelStr}" not found, falling back to root model`);
  }

  if (!ctx.model) {
    console.error("[pi-rlm] No model available for child call");
    return null;
  }
  return ctx.model;
}

/**
 * Check if an error is a rate-limit error (429).
 */
export function isRateLimitError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.message.includes("429") || err.message.includes("rate limit");
  }
  return false;
}

/**
 * Parse a child response into a structured result.
 * Per §3.5 of the design spec (FR-5.12).
 */
function parseChildResult(raw: string): ChildCallResult {
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.answer === "string" &&
      ["high", "medium", "low"].includes(parsed.confidence) &&
      Array.isArray(parsed.evidence)
    ) {
      return parsed;
    }
  } catch {
    // Fall through to fallback
  }
  // Fallback: wrap raw text
  return { answer: raw, confidence: "low", evidence: [] };
}

/**
 * Retry a function with exponential backoff on rate limit errors.
 * Per §6.6 of the design spec.
 */
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
      delay *= 2; // Exponential backoff
    }
  }
  return null; // All retries exhausted
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Child Agent Loop
// ============================================================================

/**
 * Run a child agent loop with tool support.
 * Per §6.5 of the design spec.
 * 
 * NOTE: This function requires `complete()` from @mariozechner/pi-ai to be available
 * in the calling scope. Since pi-ai types aren't directly imported to avoid circular
 * dependencies, we use dynamic typing (any) for the complete() function signature.
 * 
 * Returns both the text response and accumulated token counts.
 */
async function runChildAgentLoop(
  model: Model,
  context: {
    systemPrompt: string;
    messages: any[]; // Message[] from pi-ai
    tools: unknown[];
  },
  signal: AbortSignal,
  maxTokens: number,
  toolHandlers: Map<string, ToolHandler>,
  maxTurns: number = 5,
): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  // Import complete() and stream() dynamically to avoid compile-time dependency on pi-ai
  // In production, pi-ai must be installed and available
  let complete: any;
  let stream: any;
  try {
    const module = await import("@mariozechner/pi-ai");
    complete = module.complete;
    stream = module.stream;
  } catch (err) {
    console.error("[pi-rlm] Could not load pi-ai module — complete() unavailable");
    return {
      text: '{"answer": "Error: pi-ai not available", "confidence": "low", "evidence": []}',
      tokensIn: 0,
      tokensOut: 0,
    };
  }

  let messages = [...context.messages];
  let turns = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let useStream = false;

  while (turns < maxTurns) {
    if (signal.aborted) {
      return {
        text: '{"answer": "Aborted by user", "confidence": "low", "evidence": []}',
        tokensIn: totalTokensIn,
        tokensOut: totalTokensOut,
      };
    }

    try {
      let response: any;
      
      // If complete() threw "unsupported" on a previous turn, use stream() directly
      if (useStream) {
        response = await stream(
          model,
          {
            systemPrompt: context.systemPrompt,
            messages,
            tools: context.tools,
          },
          { signal, maxTokens },
        ).result();
      } else {
        // Try complete() first
        try {
          response = await complete(
            model,
            {
              systemPrompt: context.systemPrompt,
              messages,
              tools: context.tools,
            },
            { signal, maxTokens },
          );
        } catch (err) {
          // If complete() throws an "unsupported" error, fall back to stream()
          if (
            err instanceof Error &&
            /unsupported|not supported|not implemented/i.test(err.message)
          ) {
            useStream = true;
            response = await stream(
              model,
              {
                systemPrompt: context.systemPrompt,
                messages,
                tools: context.tools,
              },
              { signal, maxTokens },
            ).result();
          } else {
            // Re-throw non-unsupported errors
            throw err;
          }
        }
      }

      // Accumulate token counts from response
      totalTokensIn += response.usage?.inputTokens ?? 0;
      totalTokensOut += response.usage?.outputTokens ?? 0;

      // Extract text and tool calls from response.content array
      const textParts = response.content?.filter((c: any) => c.type === "text") ?? [];
      const toolCalls = response.content?.filter((c: any) => c.type === "toolCall") ?? [];

      // If no tool calls, return the text response
      if (toolCalls.length === 0) {
        return {
          text: textParts.map((c: any) => c.text).join(""),
          tokensIn: totalTokensIn,
          tokensOut: totalTokensOut,
        };
      }

      // Add the assistant message to messages
      messages.push(response);

      // Execute tool calls and collect results
      for (const toolCall of toolCalls) {
        const handler = toolHandlers.get(toolCall.name);
        let resultText: string;
        let isError: boolean;

        if (handler) {
          try {
            resultText = await handler(toolCall.arguments);
            isError = false;
          } catch (err) {
            resultText = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
            isError = true;
          }
        } else {
          // Unknown tool — return error to maintain tool-call/tool-result contract
          resultText = `Unknown tool: ${toolCall.name}. Available tools: ${[...toolHandlers.keys()].join(", ")}`;
          isError = true;
        }

        // Add tool result message
        messages.push({
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: resultText }],
          isError,
          timestamp: Date.now(),
        });
      }

      turns++;
    } catch (err) {
      if (signal.aborted) {
        return {
          text: '{"answer": "Aborted by user", "confidence": "low", "evidence": []}',
          tokensIn: totalTokensIn,
          tokensOut: totalTokensOut,
        };
      }
      // Re-throw to be caught by query() for rate limit handling
      throw err;
    }
  }

  // Max turns reached — extract text from last assistant message
  const lastAssistant = [...messages].reverse().find((m: any) => m.role === "assistant");
  if (lastAssistant?.content) {
    const text = lastAssistant.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("");
    if (text) {
      return {
        text,
        tokensIn: totalTokensIn,
        tokensOut: totalTokensOut,
      };
    }
  }

  return {
    text: '{"answer": "Max turns reached without completion", "confidence": "low", "evidence": []}',
    tokensIn: totalTokensIn,
    tokensOut: totalTokensOut,
  };
}

/**
 * Build child tool definitions (schemas) for the Pi tool call API.
 * These definitions are passed to complete() to enable tool calling.
 */
function buildChildToolDefinitions(
  toolHandlers: Map<string, ToolHandler>,
): unknown[] {
  const tools: any[] = [];

  // rlm_peek tool definition
  if (toolHandlers.has("rlm_peek")) {
    tools.push({
      name: "rlm_peek",
      description: "Retrieve a slice of externalized content by character offset",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Object ID" },
          offset: { type: "number", description: "Character offset (default 0)" },
          length: { type: "number", description: "Number of characters (default 2000)" },
        },
        required: ["id"],
      },
    });
  }

  // rlm_search tool definition
  if (toolHandlers.has("rlm_search")) {
    tools.push({
      name: "rlm_search",
      description: "Search externalized objects by pattern",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Search pattern (substring or regex)" },
          scope: {
            type: "array",
            items: { type: "string" },
            description: "Object IDs to search (default: all)",
          },
        },
        required: ["pattern"],
      },
    });
  }

  // rlm_query tool definition (only if recursion is enabled)
  if (toolHandlers.has("rlm_query")) {
    tools.push({
      name: "rlm_query",
      description: "Spawn a recursive child LLM call on specific objects",
      parameters: {
        type: "object",
        properties: {
          instructions: { type: "string", description: "Analysis task" },
          target: {
            oneOf: [
              { type: "string", description: "Single object ID" },
              { type: "array", items: { type: "string" }, description: "Array of object IDs" },
            ],
          },
          model: { type: "string", description: "Override child model" },
        },
        required: ["instructions", "target"],
      },
    });
  }

  return tools;
}

/**
 * Build child tool handlers.
 * Per §6.5.1 of the design spec.
 */
function buildChildToolHandlers(
  store: IExternalStore,
  engine: RecursiveEngine,
  callTree: CallTree,
  warmTracker: IWarmTracker,
  depth: number,
  operationId: string,
  operationSignal: AbortSignal,
  ctx: ExtensionContext,
  config: RlmConfig,
): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  // rlm_peek — always available to children
  handlers.set("rlm_peek", async (args) => {
    const obj = store.get((args.id as string) || "");
    if (!obj) return `Object ${args.id} not found`;
    const offset = (args.offset as number) ?? 0;
    const length = (args.length as number) ?? 2000;
    const slice = obj.content.slice(offset, offset + length);
    warmTracker.markWarm([(args.id as string) || ""]);
    return slice;
  });

  // rlm_search — always available to children
  handlers.set("rlm_search", async (args) => {
    const pattern = args.pattern as string;
    const scope = (args.scope as string[]) ?? store.getAllIds();
    const allMatches: SearchMatch[] = [];
    
    // Parse the pattern into regex or substring mode
    const parsed = parsePattern(pattern);
    
    for (const id of scope) {
      const obj = store.get(id);
      if (!obj) continue;
      
      let objectMatches: SearchMatch[] = [];
      
      if (parsed.kind === "regex") {
        // Use worker timeout for regex patterns
        objectMatches = await searchWithWorkerTimeout(obj.content, parsed.regex, id, 5000);
      } else {
        // Use indexOf for substring patterns
        const needle = parsed.needle;
        let startAt = 0;
        while (startAt <= obj.content.length && objectMatches.length < 50) {
          const index = obj.content.indexOf(needle, startAt);
          if (index < 0) break;
          
          const contextStart = Math.max(0, index - 100);
          const contextEnd = Math.min(obj.content.length, index + needle.length + 100);
          
          objectMatches.push({
            objectId: id,
            offset: index,
            snippet: needle,
            context: obj.content.slice(contextStart, contextEnd),
          });
          
          startAt = index + Math.max(needle.length, 1);
        }
      }
      
      allMatches.push(...objectMatches);
      if (allMatches.length >= 50) {
        allMatches.length = 50;
        break;
      }
    }
    
    warmTracker.markWarm(scope);
    
    // Format matches into string
    if (allMatches.length === 0) {
      return "No matches found.";
    }
    
    const lines: string[] = [`Found ${allMatches.length} match(es):\n`];
    for (const m of allMatches) {
      if (m.error) {
        lines.push(`**${m.objectId}**: ${m.error}`);
      } else {
        lines.push(`**${m.objectId}** [offset ${m.offset}]:`);
        lines.push(`  ...${m.context}...`);
      }
    }
    
    return lines.join("\n");
  });

  // rlm_query — only at depth < maxDepth
  if (depth + 1 < config.maxDepth) {
    handlers.set("rlm_query", async (args) => {
      const targetIds = Array.isArray(args.target) ? (args.target as string[]) : [(args.target as string) || ""];
      const result = await engine.query(
        (args.instructions as string) || "",
        targetIds,
        null,
        depth + 1,
        operationId,
        operationSignal,
        ctx,
        args.model as string | undefined,
      );
      return JSON.stringify(result);
    });
  }

  return handlers;
}

// ============================================================================
// RecursiveEngine Class
// ============================================================================

export class RecursiveEngine {
  private concurrencyLimiter: ConcurrencyLimiter;

  constructor(
    private config: RlmConfig,
    private store: IExternalStore,
    private trajectory: ITrajectoryLogger,
    private callTree: CallTree,
    private costEstimator: CostEstimator,
    private warmTracker: IWarmTracker,
  ) {
    this.concurrencyLimiter = new ConcurrencyLimiter(config.maxConcurrency);
  }

  /**
   * Spawn a single child call focused on specific targets.
   * Per §6.3 of the design spec.
   */
  async query(
    instructions: string,
    targetIds: string[],
    parentCallId: string | null,
    depth: number,
    operationId: string,
    operationSignal: AbortSignal,
    ctx: ExtensionContext,
    modelOverride?: string,
  ): Promise<ChildCallResult> {
    // 1. Check depth limit
    if (depth > this.config.maxDepth) {
      return { answer: "Max depth exceeded", confidence: "low", evidence: [] };
    }

    // 2. Per-operation budget check
    if (!this.callTree.incrementChildCalls(operationId)) {
      return { answer: "Budget exceeded", confidence: "low", evidence: [] };
    }

    // 3. Generate callId
    const callId = "rlm-call-" + randomBytes(4).toString("hex");

    // 4. Register call in callTree
    this.callTree.registerCall({
      callId,
      parentCallId,
      operationId,
      depth,
      model: modelOverride || ctx.model?.id || "unknown",
      query: instructions.slice(0, 100),
      status: "running",
      startTime: Date.now(),
      tokensIn: 0,
      tokensOut: 0,
    });

    // 5. Resolve child model
    const childModel = resolveChildModel(modelOverride, this.config, ctx);
    if (!childModel) {
      const result = { answer: "No model available for recursive call", confidence: "low" as const, evidence: [] };
      this.callTree.updateCall(callId, { status: "error" });
      return result;
    }

    // 6. Build child context
    const systemPrompt = buildChildSystemPrompt(instructions, depth, this.config);
    const targetContent = targetIds
      .map((id) => {
        const obj = this.store.get(id);
        return obj ? obj.content : `[Object ${id} not found]`;
      })
      .join("\n---\n");

    const messages: Message[] = [
      {
        role: "user",
        content: targetContent,
        timestamp: Date.now(),
      },
    ];

    // 7. Build child tools (if depth < maxDepth)
    const toolHandlers = buildChildToolHandlers(
      this.store,
      this,
      this.callTree,
      this.warmTracker,
      depth,
      operationId,
      operationSignal,
      ctx,
      this.config,
    );

    // Build tool definitions for the child context (only if depth < maxDepth)
    const tools = depth < this.config.maxDepth ? buildChildToolDefinitions(toolHandlers) : [];

    // 8. Create child abort controller with timeout
    const childController = new AbortController();
    const childTimeout = setTimeout(() => childController.abort(), this.config.childTimeoutSec * 1000);
    const onAbort = () => childController.abort();
    operationSignal.addEventListener("abort", onAbort, { once: true });

    // 9. Execute child call
    const startTime = Date.now();
    let result: ChildCallResult;
    let status: "success" | "error" | "timeout" | "cancelled" = "success";
    let tokensIn = 0;
    let tokensOut = 0;

    try {
      // Run the child agent loop with tool support
      const response = await runChildAgentLoop(
        childModel,
        { systemPrompt, messages, tools },
        childController.signal,
        this.config.childMaxTokens,
        toolHandlers,
        5,
      );

      result = parseChildResult(response.text);
      tokensIn = response.tokensIn;
      tokensOut = response.tokensOut;
      status = "success";
    } catch (err) {
      if (childController.signal.aborted) {
        result = { answer: "Timed out or cancelled", confidence: "low", evidence: [] };
        status = operationSignal.aborted ? "cancelled" : "timeout";
      } else if (isRateLimitError(err)) {
        // Retry with backoff: create a fresh AbortController+timeout and re-invoke runChildAgentLoop
        const retried = await retryWithBackoff(async () => {
          const retryController = new AbortController();
          const retryTimeout = setTimeout(() => retryController.abort(), this.config.childTimeoutSec * 1000);
          try {
            const retryResponse = await runChildAgentLoop(
              childModel,
              { systemPrompt, messages, tools },
              retryController.signal,
              this.config.childMaxTokens,
              toolHandlers,
              5,
            );
            tokensIn += retryResponse.tokensIn;
            tokensOut += retryResponse.tokensOut;
            return parseChildResult(retryResponse.text);
          } finally {
            clearTimeout(retryTimeout);
          }
        });
        result = retried || { answer: "Rate limit exceeded after retries", confidence: "low", evidence: [] };
        status = retried ? "success" : "error";
      } else {
        result = { answer: err instanceof Error ? err.message : String(err), confidence: "low", evidence: [] };
        status = "error";
      }
    } finally {
      clearTimeout(childTimeout);
      operationSignal.removeEventListener("abort", onAbort);
    }

    // 10. Log to trajectory
    const wallClockMs = Date.now() - startTime;
    this.trajectory.append({
      kind: "call",
      callId,
      operationId,
      parentCallId,
      depth,
      model: childModel.id,
      query: instructions,
      targetIds,
      result,
      tokensIn,
      tokensOut,
      wallClockMs,
      status,
      timestamp: Date.now(),
    });

    // 11. Update callTree with token counts
    this.callTree.updateCall(callId, { status, wallClockMs, tokensIn, tokensOut });

    // 12. Add call cost to estimator
    this.costEstimator.addCallCost(tokensIn, tokensOut, childModel);

    // 13. Mark content as warm
    this.warmTracker.markWarm(targetIds);

    // 14. Return result
    return result;
  }

  /**
   * Spawn parallel child calls across multiple targets.
   * Per §6.4 of the design spec.
   */
  async batch(
    instructions: string,
    targetIds: string[],
    parentCallId: string | null,
    depth: number,
    operationId: string,
    operationSignal: AbortSignal,
    ctx: ExtensionContext,
    modelOverride?: string,
  ): Promise<ChildCallResult[]> {
    const tasks = targetIds.map((id) => ({
      targetId: id,
      instructions,
    }));

    const results = await this.concurrencyLimiter.map(tasks, async (task) => {
      // Per-operation budget check
      if (!this.callTree.incrementChildCalls(operationId)) {
        return { answer: "Budget exceeded", confidence: "low" as const, evidence: [] };
      }

      return await this.query(task.instructions, [task.targetId], parentCallId, depth, operationId, operationSignal, ctx, modelOverride);
    });

    return results;
  }
}
