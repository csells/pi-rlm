/**
 * rlm_search tool: Search across externalized objects using substring or regex.
 * Per §7.2 (FR-4.2) and NFR-3.5.
 */

import { Worker } from "node:worker_threads";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { formatSearchResults, type SearchMatch } from "../store/types.js";
import type { ExtensionContext, IExternalStore, ITrajectoryLogger, IWarmTracker } from "../types.js";
import { disabledGuard, errorResult, successResult, type ToolResult } from "./guard.js";

export const RLM_SEARCH_PARAMS_SCHEMA = Type.Object({
  pattern: Type.String({ description: "Search pattern (substring or /regex/flags)" }),
  scope: Type.Optional(
    Type.Union([
      Type.Literal("all"),
      Type.Array(Type.String(), { description: "Object IDs to search (default: all)" }),
    ]),
  ),
});

export type ParsedPattern =
  | { kind: "substring"; needle: string }
  | { kind: "regex"; regex: RegExp };

interface RlmSearchState {
  enabled: boolean;
  store: IExternalStore;
  trajectory: ITrajectoryLogger;
  warmTracker: IWarmTracker;
  activePhases: Set<string>;
  updateWidget?: (ctx: ExtensionContext) => void;
}

const SEARCH_WORKER_CODE = `
const { parentPort, workerData } = require("node:worker_threads");
const { content, pattern, flags } = workerData;
const regex = new RegExp(pattern, flags);
const matches = [];
let match;
while ((match = regex.exec(content)) !== null) {
  const text = match[0] || "";
  const start = Math.max(0, match.index - 100);
  const end = Math.min(content.length, match.index + text.length + 100);
  matches.push({
    index: match.index,
    text,
    context: content.slice(start, end),
  });

  if (matches.length >= 100) break;
  if (!regex.global) break;

  // Avoid infinite loop for zero-width matches.
  if (text.length === 0) {
    regex.lastIndex += 1;
  }
}
parentPort.postMessage(matches);
`;

/**
 * Parse user pattern into regex-vs-substring mode.
 * /pattern/flags => regex mode, otherwise substring mode.
 */
export function parsePattern(pattern: string): ParsedPattern {
  const trimmed = pattern.trim();

  if (trimmed.startsWith("/")) {
    const lastSlash = trimmed.lastIndexOf("/");
    if (lastSlash > 0) {
      const source = trimmed.slice(1, lastSlash);
      const rawFlags = trimmed.slice(lastSlash + 1);

      try {
        const flags = rawFlags.includes("g") ? rawFlags : `${rawFlags}g`;
        return { kind: "regex", regex: new RegExp(source, flags) };
      } catch {
        // Fall back to substring on invalid regex.
      }
    }
  }

  return { kind: "substring", needle: pattern };
}

/**
 * Execute a regex search in a worker thread with timeout protection.
 */
export async function searchWithWorkerTimeout(
  content: string,
  regex: RegExp,
  objectId: string,
  timeoutMs: number = 5000,
): Promise<SearchMatch[]> {
  return await new Promise<SearchMatch[]>((resolve) => {
    let settled = false;

    const finish = (value: SearchMatch[]) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    let worker: Worker;

    try {
      worker = new Worker(SEARCH_WORKER_CODE, {
        eval: true,
        workerData: {
          content,
          pattern: regex.source,
          flags: regex.flags,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finish([
        {
          objectId,
          offset: 0,
          snippet: "",
          context: "",
          error: `Failed to create regex worker: ${message}`,
        },
      ]);
      return;
    }

    const timer = setTimeout(() => {
      void worker.terminate();
      finish([
        {
          objectId,
          offset: 0,
          snippet: "",
          context: "",
          error: `Regex timed out after ${timeoutMs}ms`,
        },
      ]);
    }, timeoutMs);

    worker.on("message", (rows: Array<{ index: number; text: string; context: string }>) => {
      clearTimeout(timer);
      void worker.terminate();
      finish(
        rows.map((row) => ({
          objectId,
          offset: row.index,
          snippet: row.text,
          context: row.context,
        })),
      );
    });

    worker.on("error", (err) => {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      finish([
        {
          objectId,
          offset: 0,
          snippet: "",
          context: "",
          error: `Regex error: ${message}`,
        },
      ]);
    });

    worker.on("exit", (code) => {
      if (settled) {
        return;
      }
      clearTimeout(timer);
      if (code !== 0) {
        finish([
          {
            objectId,
            offset: 0,
            snippet: "",
            context: "",
            error: `Regex worker exited with code ${code}`,
          },
        ]);
        return;
      }

      finish([]);
    });
  });
}

function searchSubstring(content: string, needle: string, objectId: string): SearchMatch[] {
  if (!needle) {
    return [];
  }

  const matches: SearchMatch[] = [];
  let startAt = 0;

  while (startAt <= content.length) {
    const index = content.indexOf(needle, startAt);
    if (index < 0) {
      break;
    }

    const contextStart = Math.max(0, index - 100);
    const contextEnd = Math.min(content.length, index + needle.length + 100);

    matches.push({
      objectId,
      offset: index,
      snippet: needle,
      context: content.slice(contextStart, contextEnd),
    });

    startAt = index + Math.max(needle.length, 1);
  }

  return matches;
}

/**
 * Build the rlm_search tool definition.
 */
export function buildRlmSearchTool(state: RlmSearchState) {
  return {
    name: "rlm_search",
    label: "RLM Search",
    description: "Search across externalized objects using text or regex patterns.",
    parameters: RLM_SEARCH_PARAMS_SCHEMA,

    async execute(
      toolCallId: string,
      params: { pattern: string; scope?: "all" | string[] },
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<ToolResult> {
      const guard = disabledGuard(state);
      if (guard) {
        return guard;
      }

      if (!params?.pattern || params.pattern.length === 0) {
        return errorResult("pattern must be a non-empty string");
      }

      const startedAt = Date.now();

      state.activePhases.add("searching");
      state.updateWidget?.(ctx);

      try {
        const parsed = parsePattern(params.pattern);
        const objectIds = Array.isArray(params.scope)
          ? params.scope
          : state.store.getAllIds();

        const matches: SearchMatch[] = [];

        for (const id of objectIds) {
          if (signal?.aborted) {
            break;
          }

          const obj = state.store.get(id);
          if (!obj) {
            continue;
          }

          const objectMatches =
            parsed.kind === "substring"
              ? searchSubstring(obj.content, parsed.needle, id)
              : await searchWithWorkerTimeout(obj.content, parsed.regex, id, 5000);

          matches.push(...objectMatches);

          if (matches.length >= 50) {
            matches.length = 50;
            break;
          }
        }

        const warmedObjectIds = [...new Set(matches.filter((m) => !m.error).map((m) => m.objectId))];
        if (warmedObjectIds.length > 0) {
          state.warmTracker.markWarm(warmedObjectIds);
        }
        state.warmTracker.markToolCallWarm(toolCallId);

        const touchedObjectIds = [...new Set(matches.map((m) => m.objectId))];
        state.trajectory.append({
          kind: "operation",
          operation: "search",
          objectIds: touchedObjectIds,
          details: {
            pattern: params.pattern,
            scope: Array.isArray(params.scope) ? params.scope : "all",
            mode: parsed.kind,
            matchCount: matches.length,
          },
          wallClockMs: Date.now() - startedAt,
          timestamp: Date.now(),
        });

        const text = formatSearchResults(matches);
        const truncation = truncateHead(text, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });

        let resultText = truncation.content;
        if (truncation.truncated) {
          resultText += "\n[Search results truncated. Use scope to narrow search.]";
        }

        return successResult(resultText, { matches });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`rlm_search failed: ${message}`);
      } finally {
        state.activePhases.delete("searching");
        state.updateWidget?.(ctx);
      }
    },
  };
}
