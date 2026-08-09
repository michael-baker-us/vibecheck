const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildVerificationReport,
  verificationSummaryText,
} = require("../dist/reports/verification-markdown");

test("builds a human-readable report while preserving diagnostic output", () => {
  const report = buildVerificationReport({
    name: "TypeScript quality",
    command: "npm run check",
    invalidatedBy: ["src/**", "test/**"],
    category: "quality",
    required: true,
    status: "failed",
    startedAt: "2026-08-09T12:00:00.000Z",
    finishedAt: "2026-08-09T12:00:01.250Z",
    durationMs: 1250,
    exitCode: 2,
    output: "\u001b[31mwarning: generated file ignored\u001b[0m\nerror TS2322: Type 'string' is not assignable\nfull compiler context",
  });

  assert.match(report, /# Quality Gate Report: TypeScript quality/);
  assert.match(report, /> Failed — The command failed with exit code 2/);
  assert.match(report, /## Diagnostic highlights/);
  assert.match(report, /warning: generated file ignored/);
  assert.match(report, /error TS2322/);
  assert.match(report, /\| Category \| quality \|/);
  assert.match(report, /\| Policy \| Required \|/);
  assert.match(report, /\| Duration \| 1\.3 s \|/);
  assert.match(report, /`src\/\*\*`, `test\/\*\*`/);
  assert.match(report, /## Raw command output/);
  assert.match(report, /full compiler context/);
  assert.doesNotMatch(report, /\u001b/);
});

test("explains test, coverage, and security summaries in plain language", () => {
  assert.equal(
    verificationSummaryText({ kind: "tests", total: 12, passed: 10, failed: 1, skipped: 1 }),
    "10 of 12 tests passed (83.33%). 1 test failed. 1 test skipped.",
  );
  assert.equal(
    verificationSummaryText({ kind: "coverage", lines: 84.25, branches: 71.2, functions: 80, statements: 86.4, change: -1.5 }),
    "Line coverage is 84.25%. This is 1.50 percentage points lower than the previous run.",
  );
  assert.equal(
    verificationSummaryText({ kind: "security", total: 2, critical: 0, high: 1, moderate: 0, low: 1, info: 0, newIssues: 1, fixedIssues: 1 }),
    "2 known vulnerabilities reported; 1 high or critical. Since the previous run: 1 new and 1 fixed.",
  );
});

test("renders detailed tables for each structured gate category", () => {
  const reports = [
    buildVerificationReport({ name: "Tests", command: "npm test", invalidatedBy: [], category: "tests", required: true, status: "passed", summary: { kind: "tests", total: 3, passed: 3, failed: 0, skipped: 0 } }),
    buildVerificationReport({ name: "Coverage", command: "npm run coverage", invalidatedBy: [], category: "coverage", required: true, status: "passed", summary: { kind: "coverage", lines: 90, branches: 80, functions: 85, statements: 91, change: 2 } }),
    buildVerificationReport({ name: "Security", command: "npm audit", invalidatedBy: [], category: "security", required: true, status: "failed", output: "audit failed", summary: { kind: "security", total: 1, critical: 1, high: 0, moderate: 0, low: 0, info: 0, newIssues: 1, fixedIssues: 0, issueIds: ["unsafe-package"] } }),
  ];

  assert.match(reports[0], /\| Passed \| 3 \|/);
  assert.match(reports[1], /\| Branches \| 80\.00% \|/);
  assert.match(reports[2], /\| Critical \| 1 \|/);
  assert.match(reports[2], /`unsafe-package`/);
});
