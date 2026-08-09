const assert = require("node:assert/strict");
const test = require("node:test");

const {
  calculateReadiness,
  categoryFor,
  missingRecommendedCategories,
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
    label: "Ready to finish",
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
