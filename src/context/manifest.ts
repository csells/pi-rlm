/**
 * ManifestBuilder: Generate compact manifest of externalized content.
 *
 * Per §3.3 and §10.1 of the design spec, the manifest is a markdown table
 * injected into the LLM's context showing recently externalized objects.
 *
 * The manifest:
 * 1. Sorts store index entries by createdAt (descending, most recent first)
 * 2. Renders rows until token budget is exceeded
 * 3. Collapses remaining entries into "+N older objects" summary
 * 4. Returns formatted markdown table with header and footer
 *
 * Token estimation: characters / 4.
 */

import { IExternalStore } from "../types.js";

/**
 * ManifestBuilder class implementing manifest generation.
 *
 * Per §3.3, the manifest is generated from the store index and injected
 * into the first user message of the context, ensuring the LLM knows
 * what's available via RLM tools.
 */
export class ManifestBuilder {
  /**
   * Create a ManifestBuilder.
   *
   * @param store - The external store to read index from
   */
  constructor(private store: IExternalStore) {}

  /**
   * Build a compact manifest for the current store state.
   *
   * Per §3.3, the manifest:
   * 1. Fetches the full store index
   * 2. Sorts entries by createdAt descending (most recent first)
   * 3. Renders rows until estimated tokens exceed budget - 200
   * 4. Collapses remaining entries as "+N older objects"
   * 5. Returns formatted markdown table
   *
   * Token estimation for manifest text: characters / 4.
   * The 200-token buffer reserves space for header/footer/control flow.
   *
   * @param budget - Token budget for manifest (e.g., 500 tokens)
   * @returns Markdown-formatted manifest string
   */
  build(budget: number): string {
    const index = this.store.getFullIndex();

    // Nothing to manifest
    if (index.objects.length === 0) {
      return `[No externalized content yet.]`;
    }

    // Sort by createdAt descending (most recent first)
    const sorted = [...index.objects].sort((a, b) => b.createdAt - a.createdAt);

    // Build table header
    const lines: string[] = [
      "## RLM External Context",
      "",
      "The following content has been externalized to the store. Use `rlm_search`, `rlm_peek`, or `rlm_query` to access.",
      "",
      "| Object ID | Type | Tokens | Description |",
      "|-----------|------|--------|-------------|",
    ];

    // Token budget: leave 200 tokens for footer/padding.
    // Ensure we can still render at least one row, even when budget is tiny.
    const tokenBudget = Math.max(1, budget - 200);
    let estimatedTokens = this.estimateTokens(lines.join("\n"));
    let renderCount = 0;

    // Render rows until budget would be exceeded.
    // Always include at least one most-recent row for discoverability.
    for (const entry of sorted) {
      const row = this.buildRow(entry);
      const rowTokens = this.estimateTokens(row);

      if (renderCount > 0 && estimatedTokens + rowTokens > tokenBudget) {
        break;
      }

      lines.push(row);
      estimatedTokens += rowTokens;
      renderCount++;
    }

    // Collapsed summary for remaining entries
    const remaining = sorted.length - renderCount;
    if (remaining > 0) {
      const olderTokens = sorted
        .slice(renderCount)
        .reduce((sum, e) => sum + e.tokenEstimate, 0);
      lines.push(
        `| **+${remaining} older** | objects | ${olderTokens} | Use rlm_search or filters to narrow scope |`
      );
    }

    // Footer
    lines.push("");
    lines.push(
      `**Total:** ${index.objects.length} objects, ${index.totalTokens} tokens externalized.`
    );
    lines.push(
      "Use rlm_search, rlm_peek, or rlm_query to access this content."
    );

    return lines.join("\n");
  }

  private buildRow(entry: {
    id: string;
    type: string;
    tokenEstimate: number;
    description: string;
  }): string {
    const safeDescription = this.escapeMarkdownCell(entry.description);
    return `| ${entry.id} | ${entry.type} | ${entry.tokenEstimate} | ${safeDescription} |`;
  }

  private escapeMarkdownCell(value: string): string {
    return value.replace(/\n+/g, " ").replace(/\|/g, "\\|");
  }

  /**
   * Estimate token count for a string (characters / 4).
   * Per §3.3, token estimation uses character count divided by 4.
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
