const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const bridge = join(__dirname, "..", "resources", "hook-bridge.cjs");

const run = (context, payload, agent = "codex") => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-bridge-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [bridge, agent], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, HOME: root },
  });
  assert.equal(result.status, 0);
  let raw = "";
  try {
    raw = readFileSync(join(root, ".vibecheck", "events.jsonl"), "utf8");
  } catch {
    return { raw: "", events: [] };
  }
  return { raw, events: raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
};

test("hook bridge stores only normalized local metadata", (context) => {
  const { events } = run(context, {
    hook_event_name: "UserPromptSubmit",
    session_id: "session-1",
    cwd: "/workspace",
    prompt: "secret prompt content",
  });
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.version, 2);
  assert.equal(event.agent, "codex");
  assert.equal(event.type, "prompt");
  assert.equal(event.workspace, "/workspace");
  assert.equal(event.sessionId, "session-1");
  assert.equal(event.prompt, undefined);
});

test("records the delegated team member for a subagent lifecycle event", (context) => {
  const { events } = run(context, {
    hook_event_name: "PreToolUse",
    session_id: "session-2",
    cwd: "/workspace",
    tool_name: "Task",
    tool_input: { subagent_type: "cody", description: "add a notification badge" },
  }, "claude");
  assert.equal(events[0].type, "tool-started");
  assert.equal(events[0].member, "cody");
  assert.equal(events[0].tool, "Task");
});

// subagent_type is the only tool argument the bridge reads, and only when it looks like a roster
// identifier. Everything else in tool_input must stay out of the file entirely.
test("rejects identifier-shaped delegation values that are not, and never records other arguments", (context) => {
  for (const subagent_type of ["../escape", "Cody", "with space", "x".repeat(80), 42, null]) {
    const { events, raw } = run(context, {
      hook_event_name: "PreToolUse",
      session_id: "session-3",
      cwd: "/workspace",
      tool_name: "Task",
      tool_input: { subagent_type, description: "add a notification badge", prompt: "secret" },
    }, "claude");
    assert.equal(events[0].member, undefined, `${String(subagent_type)} must be rejected`);
    assert.ok(!raw.includes("notification badge"), "task descriptions must never be stored");
    assert.ok(!raw.includes("secret"), "prompts must never be stored");
    assert.ok(!raw.includes("escape"));
  }
});

test("maps the turn and subagent lifecycle events the activity view depends on", (context) => {
  const cases = [
    ["Stop", "turn-stop"],
    ["SubagentStart", "subagent-start"],
    ["SubagentStop", "subagent-stop"],
    ["PostToolUse", "tool-finished"],
    ["SessionEnd", "session-end"],
  ];
  for (const [hook, type] of cases) {
    const { events } = run(context, { hook_event_name: hook, session_id: "s", cwd: "/workspace" }, "claude");
    assert.equal(events[0].type, type, `${hook} should map to ${type}`);
  }
});

test("ignores hook events it does not model", (context) => {
  const { events } = run(context, { hook_event_name: "Notification", session_id: "s", cwd: "/workspace" });
  assert.deepEqual(events, []);
});
