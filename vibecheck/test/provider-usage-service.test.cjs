const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseClaudeUsage,
  parseCodexStatus,
} = require("../dist/usage/provider-usage-service");

test("normalizes the provider-reported Codex status windows", () => {
  const result = parseCodexStatus({
    rateLimits: {
      planType: "plus",
      primary: { usedPercent: 45, windowDurationMins: 10_080, resetsAt: 1_786_842_473 },
      secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_786_800_000 },
    },
  }, "2026-08-09T12:00:00.000Z");

  assert.equal(result.status, "ready");
  assert.equal(result.source, "/status");
  assert.equal(result.summary, "Plus plan");
  assert.deepEqual(result.windows.map(({ label, usedPercent }) => ({ label, usedPercent })), [
    { label: "1-week primary window", usedPercent: 45 },
    { label: "5-hour secondary window", usedPercent: 12 },
  ]);
});

test("normalizes Claude usage without retaining diagnostic prose", () => {
  const result = parseClaudeUsage(JSON.stringify({
    is_error: false,
    result: [
      "You are currently using your subscription to power your Claude Code usage",
      "",
      "Current session: 27% used · resets Aug 9 at 5:29pm (America/New_York)",
      "Current week (all models): 2% used · resets Aug 14 at 8:59pm (America/New_York)",
      "",
      "What's contributing to your limits usage?",
      "Private local diagnostic prose that should not be retained.",
    ].join("\n"),
  }), "2026-08-09T12:00:00.000Z");

  assert.equal(result.status, "ready");
  assert.equal(result.source, "/usage");
  assert.equal(result.windows.length, 2);
  assert.equal(result.windows[0].usedPercent, 27);
  assert.doesNotMatch(JSON.stringify(result), /Private local diagnostic prose/);
});

test("rejects provider output that contains no usage windows", () => {
  assert.throws(() => parseClaudeUsage(JSON.stringify({ result: "Signed out" })), /usage windows/i);
  assert.throws(() => parseCodexStatus({ rateLimits: {} }), /usage windows/i);
});
