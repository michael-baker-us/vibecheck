const assert = require("node:assert/strict");
const test = require("node:test");

const { parseVerificationSummary } = require("../dist/verification/result-parser");

test("extracts Node test runner pass, fail, and skip totals", () => {
  const output = [
    "# tests 12",
    "# suites 2",
    "# pass 10",
    "# fail 1",
    "# skipped 1",
  ].join("\n");
  assert.deepEqual(parseVerificationSummary("tests", output), {
    kind: "tests",
    total: 12,
    passed: 10,
    failed: 1,
    skipped: 1,
  });
});

test("extracts c8 coverage and compares line coverage to the prior run", () => {
  const output = "All files | 86.4 | 71.2 | 80 | 84.25 |";
  const previous = { kind: "coverage", lines: 82, statements: 85, branches: 70, functions: 80 };
  assert.deepEqual(parseVerificationSummary("coverage", output, previous), {
    kind: "coverage",
    statements: 86.4,
    branches: 71.2,
    functions: 80,
    lines: 84.25,
    change: 2.25,
  });
});

test("tracks new and fixed npm audit vulnerability packages", () => {
  const output = JSON.stringify({
    vulnerabilities: { alpha: {}, gamma: {} },
    metadata: { vulnerabilities: { info: 0, low: 1, moderate: 0, high: 1, critical: 0, total: 2 } },
  });
  const previous = {
    kind: "security",
    total: 2,
    info: 0,
    low: 1,
    moderate: 1,
    high: 0,
    critical: 0,
    newIssues: 0,
    fixedIssues: 0,
    issueIds: ["alpha", "beta"],
  };
  assert.deepEqual(parseVerificationSummary("security", output, previous), {
    kind: "security",
    total: 2,
    critical: 0,
    high: 1,
    moderate: 0,
    low: 1,
    info: 0,
    newIssues: 1,
    fixedIssues: 1,
    issueIds: ["alpha", "gamma"],
  });
});
