const assert = require("node:assert/strict");
const test = require("node:test");

const { buildCodeReviewMarkdown } = require("../dist/reports/code-review-markdown");

test("renders provider-neutral review findings as concise Markdown", () => {
  const markdown = buildCodeReviewMarkdown({
    provider: "claude",
    status: "completed",
    baselineCommit: "abc123",
    changeFingerprint: "fingerprint",
    startedAt: "2026-08-09T12:00:00.000Z",
    finishedAt: "2026-08-09T12:01:00.000Z",
    summary: "One actionable defect was found.",
    findings: [{
      id: "finding-1",
      title: "Refresh result can be lost",
      explanation: "Concurrent refreshes overwrite the latest state.",
      severity: "medium",
      path: "src/controller.ts",
      line: 40,
      endLine: 43,
    }],
    activity: [],
  }, { branch: "feature/review" });

  assert.match(markdown, /^# VibeCheck Code Review/m);
  assert.match(markdown, /Provider: claude/);
  assert.match(markdown, /## Summary/);
  assert.match(markdown, /### 1\. MEDIUM — Refresh result can be lost/);
  assert.match(markdown, /`src\/controller\.ts:40-43`/);
});
