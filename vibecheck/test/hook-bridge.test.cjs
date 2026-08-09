const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

test("hook bridge stores only normalized local metadata", (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-bridge-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const bridge = join(__dirname, "..", "resources", "hook-bridge.cjs");
  const result = spawnSync(process.execPath, [bridge, "codex"], {
    input: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      cwd: "/workspace",
      prompt: "secret prompt content",
    }),
    encoding: "utf8",
    env: { ...process.env, HOME: root },
  });
  assert.equal(result.status, 0);
  const event = JSON.parse(readFileSync(join(root, ".vibecheck", "events.jsonl"), "utf8"));
  assert.equal(event.agent, "codex");
  assert.equal(event.type, "prompt");
  assert.equal(event.workspace, "/workspace");
  assert.equal(event.prompt, undefined);
});
