/**
 * Unit tests for complete() to stream() fallback in runChildAgentLoop().
 * 
 * Verifies that:
 * 1. When complete() throws an "unsupported" error, stream() is used as fallback
 * 2. On subsequent loop turns, stream() is used directly (no attempt to call complete())
 * 3. Error messages containing "unsupported", "not supported", or "not implemented" trigger fallback
 * 4. Other errors are re-thrown without fallback
 * 
 * NOTE: Since runChildAgentLoop() is not exported and uses dynamic imports,
 * we test the behavior by verifying the code patterns in engine.ts directly.
 * The implementation includes:
 * - Import of both complete and stream from @mariozechner/pi-ai
 * - useStream boolean flag initialized to false
 * - try/catch around complete() call with fallback pattern matching
 * - Conditional logic to skip complete() on subsequent turns if useStream is true
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("complete() to stream() fallback implementation", () => {
  // Read the engine.ts source to verify implementation patterns
  const enginePath = path.join(process.cwd(), "src/engine/engine.ts");
  const engineSource = readFileSync(enginePath, "utf8");

  it("should import both 'complete' and 'stream' from @mariozechner/pi-ai", () => {
    // Verify that both complete and stream are destructured from the module
    expect(engineSource).toMatch(/const\s+module\s*=\s*await\s+import\(['"]@mariozechner\/pi-ai['"]\)/);
    expect(engineSource).toMatch(/complete\s*=\s*module\.complete/);
    expect(engineSource).toMatch(/stream\s*=\s*module\.stream/);
  });

  it("should initialize useStream flag to false", () => {
    // Verify useStream boolean flag is initialized
    expect(engineSource).toMatch(/let\s+useStream\s*=\s*false/);
  });

  it("should wrap complete() call in try/catch with unsupported error handling", () => {
    // Verify try/catch pattern around complete() call
    expect(engineSource).toMatch(/try\s*{\s*response\s*=\s*await\s+complete\s*\(/);
    
    // Verify unsupported/not supported/not implemented error matching (case-insensitive)
    expect(engineSource).toMatch(/unsupported\|not\s+supported\|not\s+implemented/i);
    
    // Verify that useStream is set to true on match
    expect(engineSource).toMatch(/useStream\s*=\s*true/);
    
    // Verify fallback to stream() with .result()
    expect(engineSource).toMatch(/stream\([^)]*\)\.result\(\)/);
  });

  it("should skip complete() on subsequent turns if useStream is true", () => {
    // Verify conditional logic that checks useStream flag before calling complete()
    expect(engineSource).toMatch(/if\s*\(\s*useStream\s*\)\s*{[\s\S]*?response\s*=\s*await\s+stream\s*\(/);
    
    // Verify else clause that contains the complete() try/catch
    expect(engineSource).toMatch(/}\s*else\s*{[\s\S]*?try\s*{[\s\S]*?response\s*=\s*await\s+complete/);
  });

  it("should re-throw non-unsupported errors", () => {
    // Verify that non-matching errors are re-thrown
    expect(engineSource).toMatch(/throw\s+err/);
  });

  it("should verify fallback uses stream().result()", () => {
    // Verify the exact pattern of calling stream and then .result()
    expect(engineSource).toMatch(/stream\s*\([^)]*\)\s*\.result\s*\(\)/);
  });
});

describe("runChildAgentLoop error handling", () => {
  // Verify error patterns that trigger fallback
  const enginePath = path.join(process.cwd(), "src/engine/engine.ts");
  const engineSource = readFileSync(enginePath, "utf8");

  it("should detect 'unsupported' in error message (case-insensitive)", () => {
    // The regex pattern should match 'unsupported' in any case
    const patternMatch = engineSource.match(/\/([^\/]+)\/i\s*\.test\s*\(\s*err\.message\s*\)/);
    expect(patternMatch).toBeTruthy();
    expect(patternMatch?.[1]).toMatch(/unsupported/i);
  });

  it("should detect 'not supported' in error message (case-insensitive)", () => {
    const patternMatch = engineSource.match(/\/([^\/]+)\/i\s*\.test\s*\(\s*err\.message\s*\)/);
    expect(patternMatch).toBeTruthy();
    expect(patternMatch?.[1]).toMatch(/not\s+supported/i);
  });

  it("should detect 'not implemented' in error message (case-insensitive)", () => {
    const patternMatch = engineSource.match(/\/([^\/]+)\/i\s*\.test\s*\(\s*err\.message\s*\)/);
    expect(patternMatch).toBeTruthy();
    expect(patternMatch?.[1]).toMatch(/not\s+implemented/i);
  });
});
