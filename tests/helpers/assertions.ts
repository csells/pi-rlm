import { expect } from "vitest";
import type { PiHarness } from "./pi-harness";

/**
 * Assert the model called a specific tool at least once in the events.
 */
export function expectToolUsed(events: any[], toolName: string): void {
  const calls = events.filter(e =>
    e.type === "tool_execution_end" && e.toolName === toolName
  );
  expect(
    calls.length,
    `Expected model to call ${toolName} at least once`
  ).toBeGreaterThan(0);
}

/**
 * Assert the model did NOT call a specific tool in the events.
 */
export function expectToolNotUsed(events: any[], toolName: string): void {
  const calls = events.filter(e =>
    e.type === "tool_execution_end" && e.toolName === toolName
  );
  expect(
    calls.length,
    `Expected model NOT to call ${toolName}`
  ).toBe(0);
}

/**
 * Assert the last assistant message contains a substring (case-insensitive).
 */
export function expectAnswerContains(
  pi: PiHarness,
  substring: string,
  events?: any[]
): void {
  const text = pi.lastAssistantText(events);
  expect(
    text.toLowerCase(),
    `Expected answer to contain "${substring}"`
  ).toContain(substring.toLowerCase());
}

/**
 * Assert the model gave an honest "not found" response (no confabulation).
 * Checks for common honest rejection patterns.
 */
export function expectHonestMiss(pi: PiHarness, events?: any[]): void {
  const text = pi.lastAssistantText(events).toLowerCase();
  const honestPhrases = [
    "don't",
    "couldn't find",
    "no results",
    "not found",
    "didn't read",
    "no matching",
    "doesn't appear",
    "not in",
    "can't find",
    "unable to find",
    "no content",
    "not available",
    "not in",
    "wasn't",
    "wasn't in",
  ];

  const honest = honestPhrases.some(phrase => text.includes(phrase));
  expect(
    honest,
    "Model should honestly report missing content, not confabulate"
  ).toBe(true);
}
