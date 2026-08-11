const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const {
  ClaudeSessionReader,
  parseClaudeSession,
  projectDirectoryName,
} = require("../dist/team/session-reader");

const ROOT = "/repo/vibecheck";
const ts = (n) => `2026-08-10T12:0${n}:00.000Z`;

const toolUse = (name, input, id, timestamp) => JSON.stringify({
  type: "assistant",
  sessionId: "abc123",
  timestamp,
  message: { content: [{ type: "tool_use", id, name, input }] },
});

const toolResult = (id, timestamp) => JSON.stringify({
  type: "user",
  sessionId: "abc123",
  timestamp,
  message: { content: [{ type: "tool_result", tool_use_id: id }] },
});

test("encodes the repository path the way Claude names its project directory", () => {
  assert.equal(projectDirectoryName("/Users/me/repos/vibecheck"), "-Users-me-repos-vibecheck");
  assert.equal(
    projectDirectoryName("/Users/michael.baker/repos/vibecheck"),
    "-Users-michael-baker-repos-vibecheck",
  );
});

test("summarizes a session with its title, latest tool, and target", () => {
  const session = parseClaudeSession([
    JSON.stringify({ type: "ai-title", sessionId: "abc123", aiTitle: "Add notification badge" }),
    toolUse("Read", { file_path: "/repo/vibecheck/src/ui/status-bar.ts" }, "t1", ts(1)),
    toolUse("Edit", { file_path: "/repo/vibecheck/src/ui/status-bar.ts" }, "t2", ts(2)),
  ], ROOT);

  assert.equal(session.sessionId, "abc123");
  assert.equal(session.title, "Add notification badge");
  assert.equal(session.lastTool, "Edit");
  // Absolute paths are reported relative to the repository, which is what the user recognises.
  assert.equal(session.lastDetail, "src/ui/status-bar.ts");
  assert.equal(session.toolCount, 2);
  assert.equal(session.startedAt, ts(1));
  assert.equal(session.lastEventAt, ts(2));
});

test("tracks a delegation from start to finish", () => {
  const lines = [
    toolUse("Agent", { subagent_type: "cody", description: "Add the badge to the status bar" }, "d1", ts(1)),
    toolUse("Agent", { subagent_type: "renee", description: "Review the change" }, "d2", ts(2)),
    toolResult("d1", ts(3)),
  ];
  const session = parseClaudeSession(lines, ROOT);

  assert.equal(session.delegations.length, 2);
  const [cody, renee] = session.delegations;
  assert.equal(cody.member, "cody");
  assert.equal(cody.description, "Add the badge to the status bar");
  assert.equal(cody.startedAt, ts(1));
  assert.equal(cody.finishedAt, ts(3));
  // Still running: no finish record has arrived.
  assert.equal(renee.finishedAt, undefined);
});

// The tail of a live transcript routinely begins mid-record, and the file is appended to while
// being read; neither may throw.
test("skips unparseable lines instead of failing", () => {
  const session = parseClaudeSession([
    '{"type":"assistant","sessionId":"abc123","timestamp":"' + ts(1) + '","message":{"content":[{"type":"tool_u',
    "",
    "not json at all",
    toolUse("Bash", { command: "npm test" }, "t1", ts(2)),
  ], ROOT);
  assert.equal(session.sessionId, "abc123");
  assert.equal(session.lastTool, "Bash");
  assert.equal(session.lastDetail, "npm test");
});

test("returns nothing for a transcript with no usable records", () => {
  assert.equal(parseClaudeSession(["garbage", ""], ROOT), undefined);
});

// Commands are rendered verbatim in the panel, so anything credential-shaped is redacted first.
test("redacts secrets and bounds long detail", () => {
  const secret = parseClaudeSession([
    toolUse("Bash", { command: 'curl -H "authorization: Bearer sk-abc123secret" https://example.com' }, "t1", ts(1)),
  ], ROOT);
  assert.ok(!secret.lastDetail.includes("sk-abc123secret"));
  assert.ok(secret.lastDetail.includes("[REDACTED]"));

  const flags = parseClaudeSession([
    toolUse("Bash", { command: "OPENAI_API_KEY=sk-private deploy --access-token top-secret --password='two words'" }, "t1", ts(1)),
  ], ROOT);
  assert.ok(!flags.lastDetail.includes("sk-private"));
  assert.ok(!flags.lastDetail.includes("top-secret"));
  assert.ok(!flags.lastDetail.includes("two words"));

  const long = parseClaudeSession([toolUse("Bash", { command: "x".repeat(400) }, "t1", ts(1))], ROOT);
  assert.ok(long.lastDetail.length <= 121, "detail must stay bounded");
  assert.ok(long.lastDetail.endsWith("…"));
});

test("keeps paths outside the repository from leaking a full filesystem path", () => {
  const session = parseClaudeSession([
    toolUse("Read", { file_path: "/Users/someone/.ssh/config" }, "t1", ts(1)),
  ], ROOT);
  assert.equal(session.lastDetail, "config");
});

test("reads recently modified transcripts for the repository", async (context) => {
  const home = mkdtempSync(join(tmpdir(), "vibecheck-session-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const directory = join(home, ".claude", "projects", projectDirectoryName(ROOT));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "abc123.jsonl"), [
    JSON.stringify({ type: "ai-title", sessionId: "abc123", aiTitle: "Add notification badge" }),
    toolUse("Edit", { file_path: "/repo/vibecheck/src/ui/status-bar.ts" }, "t1", ts(1)),
  ].join("\n"), "utf8");
  writeFileSync(join(directory, "notes.txt"), "ignored", "utf8");

  const sessions = await new ClaudeSessionReader(home).read(ROOT);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, "Add notification badge");
});

test("ignores stale transcripts and unknown repositories", async (context) => {
  const home = mkdtempSync(join(tmpdir(), "vibecheck-session-"));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const directory = join(home, ".claude", "projects", projectDirectoryName(ROOT));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "abc123.jsonl"), toolUse("Edit", {}, "t1", ts(1)), "utf8");

  // A transcript untouched for days is not current activity.
  const future = Date.now() + 24 * 60 * 60 * 1000;
  assert.deepEqual(await new ClaudeSessionReader(home).read(ROOT, future), []);
  // A repository Claude has never run in is not an error.
  assert.deepEqual(await new ClaudeSessionReader(home).read("/repo/elsewhere"), []);
});
