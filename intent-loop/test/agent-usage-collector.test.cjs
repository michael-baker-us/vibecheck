const assert = require("node:assert/strict");
const { mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const { AgentUsageCollector } = require("../dist/collectors/agent-usage-collector");

test("aggregates local Claude and Codex usage without reading conversation content", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibecheck-usage-"));
  try {
    const codexSessions = join(root, "codex", "sessions");
    const codexDay = join(codexSessions, "2026", "08", "09");
    const claudeStats = join(root, "claude", "stats-cache.json");
    await mkdir(codexDay, { recursive: true });
    await mkdir(join(root, "claude"), { recursive: true });
    await writeFile(join(codexDay, "session.jsonl"), [
      JSON.stringify({ timestamp: "2026-08-09T12:00:00.000Z", type: "response_item", payload: { content: "must not be inspected" } }),
      JSON.stringify({ timestamp: "2026-08-09T12:01:00.000Z", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 100 } } } }),
      JSON.stringify({ timestamp: "2026-08-09T12:02:00.000Z", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 250 } }, rate_limits: { primary: { used_percent: 42, window_minutes: 300, resets_at: 1786280400 } } } }),
      "partially-written-json",
    ].join("\n"));
    await writeFile(claudeStats, JSON.stringify({
      lastComputedDate: "2026-08-09",
      dailyActivity: [{ date: "2026-08-08", sessionCount: 2 }, { date: "2026-08-09", sessionCount: 1 }],
      dailyModelTokens: [
        { date: "2026-08-08", tokensByModel: { sonnet: 1_000, opus: 500 } },
        { date: "2026-08-09", tokensByModel: { sonnet: 200 } },
      ],
    }));

    const result = await new AgentUsageCollector({ codexSessions, claudeStats })
      .collect(new Date("2026-08-09T16:00:00.000Z"));

    assert.deepEqual(
      { sessions: result.codex.sessions, tokens: result.codex.tokens, today: result.codex.todayTokens },
      { sessions: 1, tokens: 250, today: 250 },
    );
    assert.equal(result.codex.rateLimit.usedPercent, 42);
    assert.deepEqual(
      { sessions: result.claude.sessions, tokens: result.claude.tokens, today: result.claude.todayTokens },
      { sessions: 3, tokens: 1_700, today: 200 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports unavailable provider caches without failing the dashboard", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibecheck-usage-missing-"));
  try {
    const result = await new AgentUsageCollector({
      codexSessions: join(root, "missing-codex"),
      claudeStats: join(root, "missing-claude.json"),
    }).collect(new Date("2026-08-09T16:00:00.000Z"));
    assert.equal(result.codex.available, false);
    assert.equal(result.claude.available, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
