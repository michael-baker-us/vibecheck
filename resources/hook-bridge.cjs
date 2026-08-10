#!/usr/bin/env node
"use strict";

const { randomUUID } = require("node:crypto");
const { appendFileSync, chmodSync, mkdirSync, renameSync, rmSync, statSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const agent = process.argv[2] === "claude" ? "claude" : "codex";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (input.length > 1_000_000) process.exit(0);
});
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(input || "{}");
    const eventName = String(payload.hook_event_name ?? payload.hookEventName ?? "");
    const type = {
      SessionStart: "session-start",
      SessionEnd: "session-end",
      UserPromptSubmit: "prompt",
      PreToolUse: "tool-started",
      PostToolUse: "tool-finished",
      SubagentStart: "subagent-start",
      SubagentStop: "subagent-stop",
      Stop: "turn-stop",
    }[eventName];
    if (!type) return;

    /**
     * Which team member a delegation went to. This is the only tool argument the bridge reads, and
     * it is accepted only when it looks like a roster identifier: bounded charset, bounded length,
     * no paths or prose. The extension drops it again unless it matches a configured member.
     * Task descriptions and prompts are never read.
     */
    const input_ = payload.tool_input ?? payload.toolInput;
    const candidate = input_ && typeof input_ === "object" ? input_.subagent_type : undefined;
    const member = typeof candidate === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(candidate)
      ? candidate
      : undefined;

    const directory = join(homedir(), ".vibecheck");
    const eventPath = join(directory, "events.jsonl");
    const previousEventPath = join(directory, "events.previous.jsonl");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      if (statSync(eventPath).size > 5 * 1024 * 1024) {
        rmSync(previousEventPath, { force: true });
        renameSync(eventPath, previousEventPath);
      }
    } catch {
      // The active event file may not exist yet.
    }
    const event = {
      version: 2,
      id: randomUUID(),
      agent,
      type,
      workspace: typeof payload.cwd === "string" ? payload.cwd : process.cwd(),
      sessionId: typeof payload.session_id === "string" ? payload.session_id : undefined,
      tool: typeof payload.tool_name === "string" ? payload.tool_name : undefined,
      member,
      at: new Date().toISOString(),
    };
    appendFileSync(eventPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(eventPath, 0o600);
  } catch {
    // Observability must never interrupt the agent lifecycle.
  }
});
