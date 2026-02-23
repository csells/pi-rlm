import { spawn, ChildProcess } from "node:child_process";
import * as readline from "node:readline";

/**
 * PiHarness — RPC-mode test harness for E2E testing.
 * Spawns Pi in RPC mode with the extension, sends prompts via stdin JSON,
 * reads events from stdout JSON lines.
 */
export class PiHarness {
  private proc: ChildProcess;
  private rl: readline.Interface;
  private events: any[] = [];
  private pendingResolvers: Array<(event: any) => void> = [];
  private readyPromise: Promise<void>;

  /**
   * Start a Pi harness and wait for it to be ready.
   */
  static async start(extensionPath: string, opts?: {
    cwd?: string;
  }): Promise<PiHarness> {
    const harness = new PiHarness(extensionPath, opts);
    await harness.readyPromise;
    return harness;
  }

  private constructor(extensionPath: string, opts?: { cwd?: string }) {
    let readyResolve: () => void = () => {};
    this.readyPromise = new Promise(resolve => { readyResolve = resolve; });

    this.proc = spawn("pi", [
      "--mode", "rpc",
      "-e", extensionPath,
      "--no-session",
    ], {
      cwd: opts?.cwd ?? "/tmp/pi-rlm-test",
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.rl = readline.createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line) => {
      try {
        const event = JSON.parse(line);
        this.events.push(event);

        // Signal readiness on first agent_ready event
        if (event.type === "agent_ready" && this.events.length === 1) {
          readyResolve();
        }

        // Notify waiting promises
        for (let i = this.pendingResolvers.length - 1; i >= 0; i--) {
          const resolved = this.pendingResolvers[i](event);
          // If the resolver returns true, we can remove it
          if (resolved === true) {
            this.pendingResolvers.splice(i, 1);
          }
        }
      } catch {
        // Ignore non-JSON lines (stderr, etc.)
      }
    });

    this.proc.stderr?.on("data", (data) => {
      // Silently consume stderr
    });
  }

  /**
   * Send a command to Pi via RPC.
   */
  send(cmd: Record<string, any>): void {
    this.proc.stdin!.write(JSON.stringify(cmd) + "\n");
  }

  /**
   * Send a prompt and wait for agent_end. Returns events from this run.
   */
  async prompt(text: string, timeoutMs = 120_000): Promise<any[]> {
    const startIdx = this.events.length;
    this.send({ type: "prompt", message: text });
    await this.waitFor("agent_end", timeoutMs);
    return this.events.slice(startIdx);
  }

  /**
   * Steer (interrupt) during streaming with a new message.
   */
  steer(text: string): void {
    this.send({ type: "prompt", message: text, streamingBehavior: "steer" });
  }

  /**
   * Wait for a specific event type to appear.
   */
  async waitFor(type: string, timeoutMs = 60_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          // Clean up the resolver
          this.pendingResolvers = this.pendingResolvers.filter(r => r !== check);
          reject(new Error(`Timeout waiting for ${type} after ${timeoutMs}ms`));
        },
        timeoutMs
      );

      const check = (event: any) => {
        if (event.type === type) {
          clearTimeout(timer);
          resolve(event);
          return true; // Signal that this resolver can be removed
        }
        return false;
      };

      // Check if event already exists
      const existing = this.events.find(e => e.type === type);
      if (existing) {
        clearTimeout(timer);
        resolve(existing);
        return;
      }

      this.pendingResolvers.push(check);
    });
  }

  /**
   * Get all tool_execution_end events for a specific tool.
   */
  toolResults(toolName: string): any[] {
    return this.events.filter(e =>
      e.type === "tool_execution_end" && e.toolName === toolName
    );
  }

  /**
   * Get all tool_execution_end events for any rlm_* tool.
   */
  rlmToolResults(): any[] {
    return this.events.filter(e =>
      e.type === "tool_execution_end" && e.toolName?.startsWith("rlm_")
    );
  }

  /**
   * Count of auto_compaction_end events (should be 0 if RLM is working).
   */
  compactionCount(): number {
    return this.events.filter(e => e.type === "auto_compaction_end").length;
  }

  /**
   * Extract text from the last assistant message in a set of events.
   */
  lastAssistantText(events?: any[]): string {
    const pool = events ?? this.events;
    const msgs = pool
      .filter(e => e.type === "message_end" && e.message?.role === "assistant")
      .map(e => e.message);
    const last = msgs.pop();
    return last?.content
      ?.filter((c: any) => c.type === "text")
      ?.map((c: any) => c.text)
      ?.join("") ?? "";
  }

  /**
   * Reset event log (useful between scenarios in the same session).
   */
  clearEvents(): void {
    this.events = [];
  }

  /**
   * Stop the harness process.
   */
  async stop(): Promise<void> {
    this.rl.close();
    this.proc.kill("SIGTERM");
    return new Promise(resolve => {
      const onExit = () => resolve();
      this.proc.on("exit", onExit);
      // Timeout after 5s if process doesn't exit
      setTimeout(() => {
        this.proc.removeListener("exit", onExit);
        this.proc.kill("SIGKILL");
        resolve();
      }, 5000);
    });
  }
}
