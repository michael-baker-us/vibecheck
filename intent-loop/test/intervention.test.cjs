const assert = require("node:assert/strict");
const test = require("node:test");

const { buildFollowUpPrompt } = require("../dist/prompts/follow-up-builder");
const { buildMarkdownReport } = require("../dist/reports/markdown-report");

const state = {
  version: 4,
  workspaceRoot: "/tmp/repo",
  repositoryRoot: "/tmp/repo",
  baselineCommit: "abc123",
  startedAt: "2026-01-01T00:00:00.000Z",
  lastUpdatedAt: "2026-01-01T00:01:00.000Z",
  paused: false,
  planCandidates: [],
  agentFiles: [],
  activePlan: {
    path: "PLAN.md",
    title: "Keyboard controls",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    excerpt: "Keep keyboard controls working",
    tasks: [{ text: "Preserve arrow-key behavior", status: "in-progress", line: 8 }],
  },
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
    {
      name: "tests",
      command: "npm test",
      invalidatedBy: ["src/**"],
      status: "stale",
      finishedAt: "2026-01-01T00:00:30.000Z",
      durationMs: 1250,
      summary: { kind: "tests", total: 12, passed: 11, failed: 1, skipped: 0 },
    },
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
  assert.match(report, /# VibeCheck Evidence Report/);
  assert.match(report, /PLAN\.md/);
  assert.match(report, /HIGH: Tests are stale/);
  assert.match(report, /\| tests \| stale \|/);
  assert.match(report, /11\/12 passed, 1 failed/);
  assert.match(report, /1\.3 s/);
});
