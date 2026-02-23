/**
 * Inspector overlay for visualizing the recursive call tree (§10.2).
 */

import { Text } from "@mariozechner/pi-tui";
import type { CallNode, CallTree } from "../engine/call-tree.js";
import type { ExtensionContext } from "../types.js";

function renderNode(node: CallNode, indent: number, theme: any): string {
  const prefix = "  ".repeat(indent);

  const indicator =
    node.status === "running"
      ? theme.fg("warning", "●")
      : node.status === "success"
        ? theme.fg("success", "✓")
        : theme.fg("error", "✗");

  const elapsedMs =
    typeof node.wallClockMs === "number"
      ? node.wallClockMs
      : Math.max(0, Date.now() - node.startTime);

  const statusText = theme.fg("muted", node.status);
  const elapsedText = `${elapsedMs}ms`;
  const tokenText = `in:${node.tokensIn} out:${node.tokensOut} total:${
    node.tokensIn + node.tokensOut
  }`;

  const query = node.query.length > 80 ? `${node.query.slice(0, 77)}...` : node.query;

  return (
    `${prefix}${indicator} ${node.callId} [${node.model}] ${statusText} ${elapsedText} ${tokenText}` +
    `\n${prefix}  ${theme.fg("dim", query)}`
  );
}

function walk(nodes: CallNode[], indent: number, theme: any, lines: string[]): void {
  for (const node of nodes) {
    lines.push(renderNode(node, indent, theme));
    walk(node.children, indent + 1, theme, lines);
  }
}

export async function showInspector(
  ctx: ExtensionContext,
  callTree: Pick<CallTree, "getTree">,
): Promise<void> {
  if (!ctx.hasUI) {
    console.log("[pi-rlm] Inspector is unavailable without a UI context.");
    return;
  }

  const ui = (ctx as any).ui;
  if (!ui?.custom) {
    return;
  }

  await ui.custom(
    (_tui: any, theme: any, _keybindings: any, done: () => void) => {
      const tree = callTree.getTree();
      const lines = [
        theme.fg("accent", "RLM Inspector — Press Escape to close"),
        "",
      ];

      if (tree.length === 0) {
        lines.push(theme.fg("dim", "No call-tree nodes yet."));
      } else {
        walk(tree, 0, theme, lines);
      }

      const text = new Text(lines.join("\n"), 1, 1) as any;
      text.onKey = (key: string) => {
        if (key === "escape") {
          done();
          return true;
        }
        return true;
      };

      return text;
    },
    { overlay: true },
  );
}
