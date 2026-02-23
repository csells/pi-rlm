/**
 * rlm_ingest tool: ingest filesystem content into external store.
 * Per §7.5 (FR-4.6).
 */

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ExtensionContext, IExternalStore, ITrajectoryLogger, RlmConfig, StoreRecord } from "../types.js";
import { disabledGuard, errorResult, successResult, type ToolResult } from "./guard.js";

export const RLM_INGEST_PARAMS_SCHEMA = Type.Object({
  paths: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    description: "File paths or glob patterns to ingest",
  }),
});

interface RlmIngestState {
  enabled: boolean;
  store: IExternalStore;
  config: Pick<RlmConfig, "maxIngestFiles" | "maxIngestBytes">;
  trajectory: ITrajectoryLogger;
  activePhases: Set<string>;
  updateWidget?: (ctx: ExtensionContext) => void;
}

interface ResolveOptions {
  cwd: string;
}

const DEFAULT_IGNORES = ["/node_modules/", "/.git/"];

/**
 * Resolve glob patterns using fs.readdir({ recursive: true }).
 * Returns absolute file paths, deduplicated by path.
 */
export async function resolveGlobs(patterns: string[], options: ResolveOptions): Promise<string[]> {
  const cwd = path.resolve(options.cwd);

  // Snapshot cwd once for glob matching.
  const cwdFiles = (await listFilesRecursive(cwd))
    .filter((abs) => !shouldIgnoreAbsolute(abs))
    .map((abs) => ({
      abs,
      rel: toPosix(path.relative(cwd, abs)),
    }))
    .filter((entry) => entry.rel.length > 0 && !entry.rel.startsWith(".."));

  const matched = new Set<string>();

  for (const rawPattern of patterns) {
    if (!rawPattern || rawPattern.trim().length === 0) {
      continue;
    }

    const trimmed = rawPattern.trim();

    // Direct file/directory paths (absolute or relative), including paths outside cwd.
    if (!hasGlob(trimmed)) {
      const abs = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(cwd, trimmed);
      const stat = await fs.promises.stat(abs).catch(() => null);

      if (!stat) {
        continue;
      }

      if (stat.isFile()) {
        if (!shouldIgnoreAbsolute(abs)) {
          matched.add(abs);
        }
        continue;
      }

      if (stat.isDirectory()) {
        const dirFiles = await listFilesRecursive(abs);
        for (const filePath of dirFiles) {
          if (!shouldIgnoreAbsolute(filePath)) {
            matched.add(filePath);
          }
        }
        continue;
      }
    }

    // Glob patterns are expanded relative to cwd.
    const expandedPatterns = expandPathPattern(trimmed, cwd);

    for (const expanded of expandedPatterns) {
      for (const file of cwdFiles) {
        if (path.matchesGlob(file.rel, expanded)) {
          matched.add(file.abs);
        }
      }
    }
  }

  return [...matched].sort();
}

/**
 * Build the rlm_ingest tool definition.
 */
export function buildRlmIngestTool(state: RlmIngestState) {
  return {
    name: "rlm_ingest",
    label: "RLM Ingest",
    description: "Ingest files into the external store without loading them into working context.",
    parameters: RLM_INGEST_PARAMS_SCHEMA,

    async execute(
      _toolCallId: string,
      params: { paths: string[] },
      signal: AbortSignal | undefined,
      onUpdate: ((update: { content: Array<{ type: "text"; text: string }> }) => void) | undefined,
      ctx: ExtensionContext,
    ): Promise<ToolResult> {
      const guard = disabledGuard(state);
      if (guard) {
        return guard;
      }

      if (!Array.isArray(params?.paths) || params.paths.length === 0) {
        return errorResult("paths must be a non-empty array");
      }

      const startedAt = Date.now();
      state.activePhases.add("ingesting");
      state.updateWidget?.(ctx);

      try {
        const resolved = await resolveGlobs(params.paths, { cwd: ctx.cwd });

        if (resolved.length === 0) {
          return successResult("No files matched the provided paths.", {
            ingestedIds: [],
            matchedFiles: 0,
          });
        }

        if (resolved.length > state.config.maxIngestFiles) {
          return errorResult(
            `Too many files: ${resolved.length} matched, limit is ${state.config.maxIngestFiles}. ` +
              `Use more specific patterns.`,
            { matchedFiles: resolved.length, maxIngestFiles: state.config.maxIngestFiles },
          );
        }

        if (resolved.length > 10 && ctx.hasUI && (ctx as any).ui?.confirm) {
          const ok = await (ctx as any).ui.confirm(
            "RLM Ingest",
            `Ingest ${resolved.length} files into the external store?`,
          );

          if (!ok) {
            return errorResult("Cancelled by user", { matchedFiles: resolved.length });
          }
        }

        const ingestedIds: string[] = [];
        const skipped: string[] = [];
        let totalBytes = 0;

        for (let i = 0; i < resolved.length; i++) {
          const filePath = resolved[i]!;

          if (signal?.aborted) {
            skipped.push(`${filePath} (aborted)`);
            break;
          }

          const existingId = state.store.findByIngestPath(filePath);
          if (existingId) {
            skipped.push(`${filePath} (already ingested as ${existingId})`);
            continue;
          }

          const size = await fileSize(filePath);
          if (size === null) {
            skipped.push(`${filePath} (unreadable)`);
            continue;
          }

          if (totalBytes + size > state.config.maxIngestBytes) {
            skipped.push(`${filePath} (maxIngestBytes exceeded)`);
            continue;
          }

          if (await isBinaryFile(filePath)) {
            skipped.push(`${filePath} (binary)`);
            continue;
          }

          let content: string;
          try {
            content = await fs.promises.readFile(filePath, "utf8");
          } catch {
            skipped.push(`${filePath} (read failed)`);
            continue;
          }

          const tokenEstimate = Math.ceil(content.length / 4);
          const recordInput: Omit<StoreRecord, "id" | "createdAt"> = {
            type: "file",
            description: path.relative(ctx.cwd, filePath),
            tokenEstimate,
            source: { kind: "ingested", path: filePath },
            content,
          };

          const added = state.store.add(recordInput);
          ingestedIds.push(added.id);
          totalBytes += size;

          onUpdate?.({
            content: [{ type: "text", text: `Ingested ${ingestedIds.length}/${resolved.length}: ${filePath}` }],
          });
        }

        state.trajectory.append({
          kind: "operation",
          operation: "ingest",
          objectIds: ingestedIds,
          details: {
            paths: params.paths,
            matchedFiles: resolved.length,
            ingestedCount: ingestedIds.length,
            skippedCount: skipped.length,
            totalBytes,
          },
          wallClockMs: Date.now() - startedAt,
          timestamp: Date.now(),
        });

        let message = `Ingested ${ingestedIds.length} file(s), ${totalBytes.toLocaleString()} bytes.`;
        if (ingestedIds.length > 0) {
          message += `\nObject IDs:\n${ingestedIds.join("\n")}`;
        }
        if (skipped.length > 0) {
          const preview = skipped.slice(0, 10);
          message += `\n\nSkipped ${skipped.length} file(s):\n${preview.join("\n")}`;
          if (skipped.length > preview.length) {
            message += `\n...and ${skipped.length - preview.length} more`;
          }
        }

        const truncation = truncateHead(message, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });

        let text = truncation.content;
        if (truncation.truncated) {
          text += "\n[Ingest output truncated. Narrow paths to inspect details.]";
        }

        return successResult(text, {
          ingestedIds,
          matchedFiles: resolved.length,
          skippedCount: skipped.length,
          totalBytes,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`rlm_ingest failed: ${message}`);
      } finally {
        state.activePhases.delete("ingesting");
        state.updateWidget?.(ctx);
      }
    },
  };
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function hasGlob(pattern: string): boolean {
  return /[*?[]/.test(pattern);
}

function expandPathPattern(rawPattern: string, cwd: string): string[] {
  const normalized = toPosix(rawPattern);

  if (hasGlob(normalized)) {
    return [stripLeadingSlashIfNeeded(normalized)];
  }

  const abs = path.isAbsolute(rawPattern) ? rawPattern : path.resolve(cwd, rawPattern);

  try {
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      const rel = toPosix(path.relative(cwd, abs));
      if (rel.startsWith("..")) {
        return [];
      }

      const normalizedRel = stripLeadingSlashIfNeeded(rel);
      return [normalizedRel ? `${normalizedRel}/**/*` : "**/*"];
    }
  } catch {
    // fall through; treat as plain path pattern
  }

  const rel = path.isAbsolute(rawPattern)
    ? toPosix(path.relative(cwd, rawPattern))
    : normalized;

  if (rel.startsWith("..")) {
    return [];
  }

  return [stripLeadingSlashIfNeeded(rel)];
}

function stripLeadingSlashIfNeeded(value: string): string {
  return value.replace(/^\.\//, "").replace(/^\//, "");
}

function shouldIgnoreAbsolute(absPath: string): boolean {
  const normalized = `/${toPosix(absPath)}/`;
  return DEFAULT_IGNORES.some((segment) => normalized.includes(segment));
}

async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const entries = await fs.promises.readdir(rootDir, {
    recursive: true,
    withFileTypes: true,
  });

  const files: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const parentPath = "parentPath" in entry
      ? (entry as fs.Dirent & { parentPath?: string }).parentPath
      : rootDir;

    files.push(path.resolve(parentPath ?? rootDir, entry.name));
  }

  return files;
}

async function fileSize(filePath: string): Promise<number | null> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

async function isBinaryFile(filePath: string): Promise<boolean> {
  let handle: fs.promises.FileHandle | null = null;

  try {
    handle = await fs.promises.open(filePath, "r");
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, 512, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } catch {
    return false;
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}
