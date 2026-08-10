const assert = require("node:assert/strict");
const test = require("node:test");

const {
  calculateReadiness,
  categoryFor,
  missingRecommendedCategories,
  readinessBadge,
} = require("../dist/domain/quality-gates");

const definition = (name, command, category) => ({
  name,
  command,
  invalidatedBy: ["src/**"],
  required: true,
  ...(category ? { category } : {}),
});

test("classifies quality gates and reports missing recommended coverage", () => {
  const definitions = [
    definition("unit tests", "npm test"),
    definition("dependencies", "npm audit --audit-level=high", "security"),
  ];
  assert.equal(categoryFor(definitions[0]), "tests");
  assert.deepEqual(missingRecommendedCategories(definitions), ["coverage"]);
});

test("requires configured checks to pass and high-risk findings to be resolved", () => {
  const check = { ...definition("tests", "npm test", "tests"), status: "passed" };
  assert.deepEqual(calculateReadiness([], [check]), {
    status: "ready",
    label: "Checks current",
    reasons: [],
  });

  const finding = {
    id: "risk",
    fingerprint: "risk",
    title: "Sensitive change",
    explanation: "Review it",
    severity: "high",
    basis: "fact",
    status: "open",
    evidence: [],
  };
  const result = calculateReadiness([finding], [{ ...check, status: "stale" }]);
  assert.equal(result.status, "blocked");
  assert.equal(result.reasons.length, 2);
});

test("badges the view whenever the Status page is not reporting current checks", () => {
  assert.equal(readinessBadge(undefined), undefined);
  assert.equal(readinessBadge({ status: "ready", label: "Checks current", reasons: [] }), undefined);

  const incomplete = readinessBadge({
    status: "incomplete",
    label: "Checks needed",
    reasons: ["1 required check not complete", "Missing recommended gates: coverage"],
  });
  assert.equal(incomplete.value, 2);
  assert.match(incomplete.tooltip, /^VibeCheck: Checks needed\n/);
  assert.match(incomplete.tooltip, /• Missing recommended gates: coverage$/);

  // A status can be non-ready without enumerated reasons; the badge still has to be visible.
  assert.deepEqual(readinessBadge({ status: "blocked", label: "Action needed", reasons: [] }), {
    value: 1,
    tooltip: "VibeCheck: Action needed",
  });
});
