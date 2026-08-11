const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ENDED_AFTER_MS,
  IDLE_AFTER_MS,
  applyAgentEvent,
  decayActivity,
  emptyActivity,
  reconcileActivity,
} = require("../dist/team/activity-tracker");
const { adapterConnectionState } = require("../dist/domain/team");

const ROSTER = new Set(["cody", "renee", "scout"]);
const T0 = Date.parse("2026-08-10T12:00:00.000Z");
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString();

const event = (overrides = {}) => ({
  version: 2,
  id: Math.random().toString(36).slice(2),
  agent: "claude",
  type: "tool-finished",
  workspace: "/repo",
  sessionId: "session-a",
  at: at(0),
  ...overrides,
});

const fold = (events, now = T0) =>
  events.reduce((activity, item) => applyAgentEvent(activity, item, ROSTER, now), emptyActivity());

test("derives adapter connection state from decaying provider session status", () => {
  const active = { sessionId: "active", agent: "codex", status: "active", startedAt: at(0), lastEventAt: at(0), toolCount: 0 };
  const idle = { ...active, sessionId: "idle", status: "idle" };
  const ended = { ...active, sessionId: "ended", status: "ended" };
  const claude = { ...active, sessionId: "claude", agent: "claude" };

  assert.equal(adapterConnectionState(true, [active], "codex"), "active");
  assert.equal(adapterConnectionState(true, [idle], "codex"), "observed-idle");
  assert.equal(adapterConnectionState(true, [ended], "codex"), "observed-idle");
  assert.equal(adapterConnectionState(true, [claude], "codex"), "awaiting");
  assert.equal(adapterConnectionState(false, [], "codex"), "not-installed");
  assert.equal(adapterConnectionState(false, [ended], "codex"), "not-installed");
});

test("builds a session timeline from lifecycle events", () => {
  const activity = fold([
    event({ type: "session-start", at: at(0) }),
    event({ type: "tool-started", tool: "Read", at: at(1000) }),
    event({ type: "tool-finished", tool: "Read", at: at(2000) }),
    event({ type: "tool-finished", tool: "Edit", at: at(3000) }),
  ], T0 + 3000);

  assert.equal(activity.sessions.length, 1);
  const [session] = activity.sessions;
  assert.equal(session.sessionId, "session-a");
  assert.equal(session.agent, "claude");
  assert.equal(session.status, "active");
  assert.equal(session.startedAt, at(0));
  assert.equal(session.lastTool, "Edit");
  assert.equal(session.toolCount, 2);
});

test("attributes work to a roster member for the life of the delegation", () => {
  const activity = fold([
    event({ type: "session-start", at: at(0) }),
    event({ type: "subagent-start", member: "cody", at: at(1000) }),
    event({ type: "tool-finished", tool: "Edit", at: at(2000) }),
  ], T0 + 2000);
  assert.equal(activity.sessions[0].member, "cody");
  assert.equal(activity.sessions[0].lastTool, "Edit");

  // Once the subagent stops, the session is back to its own work and must not stay attributed.
  const after = applyAgentEvent(activity, event({ type: "subagent-stop", at: at(3000) }), ROSTER, T0 + 3000);
  assert.equal(after.sessions[0].member, undefined);
});

// The bridge bounds the identifier's shape; this is the second bound, and the one that matters:
// nothing reaches workspace state unless it names a configured member.
test("drops delegation identifiers that are not configured members", () => {
  for (const member of ["not-a-member", "../escape", ""]) {
    const activity = fold([event({ type: "subagent-start", member, at: at(0) })]);
    assert.equal(activity.sessions[0].member, undefined, `${member} must not be attributed`);
  }
});

test("never records anything beyond lifecycle metadata", () => {
  const activity = fold([
    event({ type: "subagent-start", member: "cody", description: "add a notification badge", prompt: "secret" }),
  ]);
  const serialized = JSON.stringify(activity);
  assert.ok(!serialized.includes("notification badge"));
  assert.ok(!serialized.includes("secret"));
  assert.deepEqual(Object.keys(activity.sessions[0]).sort(), [
    "agent", "lastEventAt", "member", "sessionId", "startedAt", "status", "toolCount",
  ]);
});

test("tracks concurrent sessions independently, most recent first", () => {
  const activity = fold([
    event({ sessionId: "a", type: "session-start", at: at(0) }),
    event({ sessionId: "b", agent: "codex", type: "session-start", at: at(1000) }),
    event({ sessionId: "a", type: "tool-finished", tool: "Read", at: at(2000) }),
  ], T0 + 2000);

  assert.deepEqual(activity.sessions.map((s) => s.sessionId), ["a", "b"]);
  assert.equal(activity.sessions.find((s) => s.sessionId === "b").agent, "codex");
});

test("ends a session on session-end", () => {
  const activity = fold([
    event({ type: "session-start", at: at(0) }),
    event({ type: "session-end", at: at(1000) }),
  ], T0 + 1000);
  assert.equal(activity.sessions[0].status, "ended");
  assert.equal(activity.sessions[0].member, undefined);
});

// A crashed or killed session never emits session-end, so liveness has to decay on its own or the
// panel would show work in progress forever.
test("decays a silent session to idle and then ended", () => {
  const activity = fold([event({ type: "session-start", at: at(0) })], T0);
  assert.equal(activity.sessions[0].status, "active");

  assert.equal(decayActivity(activity, T0 + IDLE_AFTER_MS).sessions[0].status, "idle");
  assert.equal(decayActivity(activity, T0 + ENDED_AFTER_MS).sessions[0].status, "ended");
  // Decay is stable: an unchanged result must not churn persisted state.
  assert.equal(decayActivity(activity, T0 + 1000), activity);
});

test("caps retained sessions", () => {
  const events = Array.from({ length: 30 }, (_, index) =>
    event({ sessionId: `session-${index}`, type: "session-start", at: at(index * 1000) }));
  assert.equal(fold(events, T0 + 30000).sessions.length, 20);
});

test("accepts v1 events but reports that attribution is unavailable", () => {
  const legacy = fold([{ version: 1, id: "x", agent: "claude", type: "tool-finished", sessionId: "a", tool: "Read", at: at(0) }]);
  assert.equal(legacy.attributionCapable, false);
  assert.equal(legacy.sessions[0].lastTool, "Read");

  const current = fold([event({ type: "tool-finished", tool: "Read" })]);
  assert.equal(current.attributionCapable, true);
});

test("ignores events without a session id", () => {
  const activity = fold([event({ sessionId: undefined, type: "session-start" })]);
  assert.deepEqual(activity.sessions, []);
});

test("drops attribution when a member leaves the roster", () => {
  const activity = fold([event({ type: "subagent-start", member: "cody", at: at(0) })]);
  assert.equal(activity.sessions[0].member, "cody");

  const reconciled = reconcileActivity(activity, new Set(["renee"]));
  assert.equal(reconciled.sessions[0].member, undefined);
  // Unchanged rosters must not produce a new object, so state does not churn on every refresh.
  assert.equal(reconcileActivity(activity, ROSTER), activity);
});
