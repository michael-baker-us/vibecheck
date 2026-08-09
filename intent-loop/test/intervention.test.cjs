const assert = require("node:assert/strict");
const test = require("node:test");

const { buildFollowUpPrompt } = require("../dist/prompts/follow-up-builder");
const { buildMarkdownReport } = require("../dist/reports/markdown-report");

const state = {
  version: 2,
  workspaceRoot: "/tmp/repo",
  repositoryRoot: "/tmp/repo",
  baselineCommit: "abc123",
  startedAt: "2026-01-01T00:00:00.000Z",
  lastUpdatedAt: "2026-01-01T00:01:00.000Z",
  paused: false,
  workingIntent: "Keep keyboard controls working",
  changedFiles: [{ path: "src/input.ts", status: "modified", binary: false }],
  findings: [
    {
      id: "finding-1",
      fingerprint: "fingerprint",
      ruleId: "test.rule",
      title: "Tests are stale",
      explanation: "Input changed after verification.",
      severity: "high",
      basis: "fact",
      evidence: [{ path: "src/input.ts", line: 3, detail: "Changed input" }],
      status: "open",
      firstObservedAt: "2026-01-01T00:00:00.000Z",
      lastObservedAt: "2026-01-01T00:01:00.000Z",
    },
  ],
  verification: [
    { name: "tests", command: "npm test", invalidatedBy: ["src/**"], status: "stale" },
  ],
  trustedCommandHashes: [],
  agent: { connectedAgents: [] },
};

test("builds a concrete follow-up prompt and local review", () => {
  const prompt = buildFollowUpPrompt(state);
  assert.match(prompt, /Keep keyboard controls working/);
  assert.match(prompt, /src\/input\.ts:3/);
  assert.match(prompt, /tests: stale/);

  const report = buildMarkdownReport(state);
  assert.match(report, /# Intent Loop Review/);
  assert.match(report, /HIGH: Tests are stale/);
  assert.match(report, /\| tests \| stale \|/);
});
