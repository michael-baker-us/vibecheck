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
      PostToolUse: "tool-finished",
      Stop: "turn-stop",
    }[eventName];
    if (!type) return;

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
      version: 1,
      id: randomUUID(),
      agent,
      type,
      workspace: typeof payload.cwd === "string" ? payload.cwd : process.cwd(),
      sessionId: typeof payload.session_id === "string" ? payload.session_id : undefined,
      tool: typeof payload.tool_name === "string" ? payload.tool_name : undefined,
      at: new Date().toISOString(),
    };
    appendFileSync(eventPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(eventPath, 0o600);
  } catch {
    // Observability must never interrupt the agent lifecycle.
  }
});
