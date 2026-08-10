import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";

import * as vscode from "vscode";

import { AGENT_EVENT_TYPES, AgentEvent, AgentEventType } from "../domain/agent-events";

export class LocalEventReader implements vscode.Disposable {
  private readonly eventPath = path.join(homedir(), ".vibecheck", "events.jsonl");
  private offset = 0;
  private timer: NodeJS.Timeout | undefined;
  private reading = false;
  private readonly seen = new Set<string>();

  public constructor(
    private readonly onEvent: (event: AgentEvent) => void,
    private readonly output: vscode.OutputChannel,
  ) {}

  public start(): void {
    this.timer = setInterval(() => void this.readNewEvents(), 1500);
    void this.readNewEvents();
  }

  public dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async readNewEvents(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      const file = await stat(this.eventPath);
      if (file.size < this.offset) this.offset = 0;
      if (file.size === this.offset) return;
      const stream = createReadStream(this.eventPath, { start: this.offset, end: file.size - 1 });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of lines) {
        try {
          const event = this.validate(JSON.parse(line));
          if (event && !this.seen.has(event.id)) {
            this.seen.add(event.id);
            if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
            this.onEvent(event);
          }
        } catch {
          this.output.appendLine("Ignored malformed local agent event.");
        }
      }
      this.offset = file.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.output.appendLine(`Agent event read failed: ${String(error)}`);
      }
    } finally {
      this.reading = false;
    }
  }

  /**
   * Version 1 is still accepted: `install()` only replaces the bridge when the user reinstalls the
   * adapter, so an older bridge keeps emitting v1 lines after the extension updates.
   *
   * `member` is re-validated here rather than trusted. The bridge already bounds it, but this file
   * is plain text on disk that anything could append to.
   */
  private validate(value: unknown): AgentEvent | undefined {
    if (!value || typeof value !== "object") return undefined;
    const event = value as Partial<AgentEvent>;
    if (
      (event.version !== 1 && event.version !== 2) ||
      typeof event.id !== "string" ||
      (event.agent !== "codex" && event.agent !== "claude") ||
      !AGENT_EVENT_TYPES.includes(event.type as AgentEventType) ||
      typeof event.at !== "string"
    ) {
      return undefined;
    }
    const member = typeof event.member === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(event.member)
      ? event.member
      : undefined;
    return { ...event, member } as AgentEvent;
  }
}
