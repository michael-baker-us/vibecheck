const assert = require("node:assert/strict");
const test = require("node:test");

const { parseVerificationResult, parseVerificationSummary } = require("../dist/verification/result-parser");
const { VERIFICATION_FORMAT_ADAPTERS } = require("../dist/verification/formats");
const { VERIFICATION_FORMATS } = require("../dist/domain/configuration");

// --- tests -------------------------------------------------------------------------------------

test("reads vitest totals, which are indented and carry no colon after Tests", () => {
  const output = [
    " ✓ src/game/world.test.ts (32 tests) 5667ms",
    "",
    " Test Files  36 passed (36)",
    "      Tests  330 passed (330)",
    "   Start at  19:09:04",
    "   Duration  8.75s",
  ].join("\n");
  const result = parseVerificationResult("tests", output);
  assert.equal(result.format, "vitest");
  assert.deepEqual(result.summary, { kind: "tests", total: 330, passed: 330, failed: 0, skipped: 0 });
});

test("reads a mixed vitest run with failures and skips", () => {
  const output = "      Tests  2 failed | 327 passed | 1 skipped (330)";
  assert.deepEqual(parseVerificationSummary("tests", output), {
    kind: "tests",
    total: 330,
    passed: 327,
    failed: 2,
    skipped: 1,
  });
});

test("reads mocha spec totals", () => {
  const output = ["  330 passing (8s)", "  1 pending", "  2 failing"].join("\n");
  assert.deepEqual(parseVerificationSummary("tests", output), {
    kind: "tests",
    total: 333,
    passed: 330,
    failed: 2,
    skipped: 1,
  });
});

test("sums JUnit XML suites and treats errors as failures", () => {
  const output = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<testsuites>",
    '  <testsuite name="a" tests="10" failures="1" errors="1" skipped="2"></testsuite>',
    '  <testsuite name="b" tests="5" failures="0" errors="0" skipped="0"></testsuite>',
    "</testsuites>",
  ].join("\n");
  const result = parseVerificationResult("tests", output);
  assert.equal(result.format, "junit");
  assert.deepEqual(result.summary, { kind: "tests", total: 15, passed: 11, failed: 2, skipped: 2 });
});

test("prefers the JUnit testsuites root totals when it carries them", () => {
  const output = '<testsuites tests="42" failures="3" skipped="1"><testsuite tests="42" failures="3" skipped="1"/></testsuites>';
  assert.deepEqual(parseVerificationSummary("tests", output), {
    kind: "tests",
    total: 42,
    passed: 38,
    failed: 3,
    skipped: 1,
  });
});

test("keeps reading TAP and Jest output", () => {
  const tap = ["# tests 12", "# pass 10", "# fail 1", "# skipped 1"].join("\n");
  assert.equal(parseVerificationResult("tests", tap).format, "tap");

  const jest = "Tests:       1 failed, 1 skipped, 10 passed, 12 total";
  const result = parseVerificationResult("tests", jest);
  assert.equal(result.format, "jest");
  assert.deepEqual(result.summary, { kind: "tests", total: 12, passed: 10, failed: 1, skipped: 1 });
});

// --- coverage ----------------------------------------------------------------------------------

test("computes coverage percentages from an LCOV tracefile", () => {
  const output = [
    "SF:src/a.ts",
    "FNF:10", "FNH:8",
    "BRF:20", "BRH:10",
    "LF:100", "LH:90",
    "end_of_record",
    "SF:src/b.ts",
    "FNF:10", "FNH:9",
    "BRF:0", "BRH:0",
    "LF:100", "LH:80",
    "end_of_record",
  ].join("\n");
  const result = parseVerificationResult("coverage", output);
  assert.equal(result.format, "lcov");
  assert.deepEqual(result.summary, {
    kind: "coverage",
    lines: 85,
    statements: 85,
    branches: 50,
    functions: 85,
  });
});

test("reads Cobertura line and branch rates", () => {
  const output = '<coverage line-rate="0.8753" branch-rate="0.7058" version="1.9"><packages/></coverage>';
  const result = parseVerificationResult("coverage", output);
  assert.equal(result.format, "cobertura");
  assert.deepEqual(result.summary, { kind: "coverage", lines: 87.53, statements: 87.53, branches: 70.58 });
});

test("reads a pytest-cov TOTAL row and a go coverage line", () => {
  assert.deepEqual(parseVerificationSummary("coverage", "TOTAL      1234     56    95%"), {
    kind: "coverage",
    lines: 95,
    statements: 95,
  });
  const go = parseVerificationResult("coverage", "coverage: 87.5% of statements");
  assert.equal(go.format, "go-coverage");
  assert.equal(go.summary.lines, 87.5);
});

test("still compares coverage against the previous run", () => {
  const previous = { kind: "coverage", lines: 82 };
  const result = parseVerificationSummary("coverage", "All files | 86.4 | 71.2 | 80 | 84.25 |", previous);
  assert.equal(result.change, 2.25);
});

// --- security ----------------------------------------------------------------------------------

test("counts SARIF results by security-severity and falls back to level", () => {
  const output = JSON.stringify({
    version: "2.1.0",
    runs: [{
      results: [
        { ruleId: "rule-a", level: "error", properties: { "security-severity": "9.1" } },
        { ruleId: "rule-b", level: "error", properties: { "security-severity": "7.5" } },
        { ruleId: "rule-c", level: "warning" },
        { ruleId: "rule-d", level: "note" },
      ],
    }],
  });
  const result = parseVerificationResult("security", output);
  assert.equal(result.format, "sarif");
  assert.equal(result.summary.total, 4);
  assert.equal(result.summary.critical, 1);
  assert.equal(result.summary.high, 1);
  assert.equal(result.summary.moderate, 1);
  assert.equal(result.summary.low, 1);
  assert.deepEqual(result.summary.issueIds, ["rule-a", "rule-b", "rule-c", "rule-d"]);
});

test("reports new and fixed SARIF findings against the previous run", () => {
  const output = JSON.stringify({
    version: "2.1.0",
    runs: [{ results: [{ ruleId: "kept", level: "warning" }, { ruleId: "new", level: "warning" }] }],
  });
  const previous = { kind: "security", total: 2, critical: 0, high: 0, moderate: 2, low: 0, info: 0, newIssues: 0, fixedIssues: 0, issueIds: ["kept", "gone"] };
  const summary = parseVerificationSummary("security", output, previous);
  assert.equal(summary.newIssues, 1);
  assert.equal(summary.fixedIssues, 1);
});

test("still reads npm audit JSON and text output", () => {
  const json = JSON.stringify({ metadata: { vulnerabilities: { total: 3, critical: 1, high: 2, moderate: 0, low: 0, info: 0 } } });
  assert.equal(parseVerificationResult("security", json).format, "npm-audit-json");
  assert.equal(parseVerificationResult("security", "found 0 vulnerabilities").format, "npm-audit-text");
});

// --- registry behaviour ------------------------------------------------------------------------

test("flags measurable categories whose output no adapter recognised", () => {
  const result = parseVerificationResult("tests", "everything is fine, trust me");
  assert.equal(result.summary, undefined);
  assert.equal(result.unrecognized, true);
});

test("does not flag categories that are not expected to produce metrics", () => {
  assert.deepEqual(parseVerificationResult("build", "Compiled successfully"), { unrecognized: false });
  assert.deepEqual(parseVerificationResult("quality", "no lint errors"), { unrecognized: false });
});

test("format: none disables parsing even when the output would match", () => {
  const output = "      Tests  330 passed (330)";
  assert.deepEqual(parseVerificationResult("tests", output, undefined, "none"), { unrecognized: false });
});

test("an explicit format pins one adapter instead of auto-detecting", () => {
  const output = ["  10 passing", "      Tests  330 passed (330)"].join("\n");
  assert.equal(parseVerificationResult("tests", output, undefined, "mocha").summary.total, 10);
  assert.equal(parseVerificationResult("tests", output, undefined, "vitest").summary.total, 330);
  // A pinned adapter that does not match reports unrecognised rather than falling back.
  assert.equal(parseVerificationResult("tests", output, undefined, "junit").unrecognized, true);
});

test("format: auto behaves like no format at all", () => {
  const output = "      Tests  330 passed (330)";
  assert.deepEqual(
    parseVerificationResult("tests", output, undefined, "auto"),
    parseVerificationResult("tests", output),
  );
});

test("every adapter id is a declared configuration format", () => {
  for (const adapter of VERIFICATION_FORMAT_ADAPTERS) {
    assert.ok(VERIFICATION_FORMATS.includes(adapter.id), `${adapter.id} must be selectable in config.yaml`);
    assert.ok(adapter.label, `${adapter.id} needs a label`);
  }
  const ids = VERIFICATION_FORMAT_ADAPTERS.map((adapter) => adapter.id);
  assert.equal(new Set(ids).size, ids.length, "adapter ids must be unique");
});

test("no adapter claims output belonging to another category", () => {
  const samples = {
    tests: "      Tests  330 passed (330)",
    coverage: "All files | 86.4 | 71.2 | 80 | 84.25 |",
    security: "found 0 vulnerabilities",
  };
  for (const [category, output] of Object.entries(samples)) {
    for (const adapter of VERIFICATION_FORMAT_ADAPTERS) {
      if (adapter.category === category) continue;
      assert.equal(adapter.parse(output), undefined, `${adapter.id} must not claim ${category} output`);
    }
  }
});
