/**
 * Phases: Operational state enum for RLM activities.
 *
 * Per §6.4 (Widget Rendering) and §10.1, phases represent active operational
 * states tracked during context externalization, searching, querying, etc.
 *
 * The Phase type covers active states only. "Idle" (no active phases) is
 * represented by activePhases.size === 0 and is not a Phase value.
 *
 * Each tool and event handler adds its phase to a Set<Phase> while active,
 * and removes it when complete. The widget displays active phases to the user.
 */

/**
 * Phase type — represents an active RLM operational state.
 *
 * Per §6.4:
 * - "externalizing" — context event handler is running
 * - "searching" — rlm_search is running
 * - "querying" — rlm_query child call is running
 * - "batching" — rlm_batch parallel child calls are running
 * - "synthesizing" — rlm_ingest is processing files or rlm_batch is synthesizing results
 * - "ingesting" — rlm_ingest is processing files
 */
export type Phase =
  | "externalizing"
  | "searching"
  | "querying"
  | "batching"
  | "synthesizing"
  | "ingesting";

/**
 * Human-readable labels for phases.
 * Used by the widget for display.
 */
export const phaseLabels: Record<Phase, string> = {
  externalizing: "Externalizing",
  searching: "Searching",
  querying: "Querying",
  batching: "Batching",
  synthesizing: "Synthesizing",
  ingesting: "Ingesting",
};

/**
 * Phase order for display (used by widget to order phases in rendering).
 * Earlier phases in the array appear first in the widget.
 */
export const phaseOrder: Phase[] = [
  "externalizing",
  "ingesting",
  "searching",
  "querying",
  "batching",
  "synthesizing",
];

/**
 * Get a human-readable label for a phase.
 *
 * @param phase - The phase enum value
 * @returns Display label (e.g., "Searching" for "searching")
 */
export function getPhaseLabel(phase: Phase): string {
  return phaseLabels[phase];
}

/**
 * Sort phases by display order.
 *
 * @param phases - Array of phases
 * @returns Sorted array per phaseOrder
 */
export function sortPhases(phases: Phase[]): Phase[] {
  return [...phases].sort(
    (a, b) => phaseOrder.indexOf(a) - phaseOrder.indexOf(b)
  );
}

/**
 * Format active phases as a display string.
 *
 * @param phases - Array of active phases
 * @returns Comma-separated display string (e.g., "Externalizing, Searching")
 */
export function formatPhases(phases: Phase[]): string {
  const sorted = sortPhases(phases);
  return sorted.map((p) => getPhaseLabel(p)).join(", ");
}
