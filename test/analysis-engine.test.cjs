const assert = require("node:assert/strict");
const test = require("node:test");

const { AnalysisEngine } = require("../dist/analyzers/analysis-engine");

test("detects deterministic risk signals and configured boundaries", () => {
  const engine = new AnalysisEngine();
  const changes = [
    {
      path: "package.json",
      status: "modified",
      binary: false,
      before: JSON.stringify({ dependencies: {} }),
      after: JSON.stringify({ dependencies: { leftpad: "1.0.0" } }),
    },
    {
      path: "tests/input.test.ts",
      status: "modified",
      binary: false,
      before: "test('works', () => expect(true).toBe(true));\n",
      after: "test.skip('works', () => {});\n",
    },
    {
      path: "src/input/controller.ts",
      status: "modified",
      binary: false,
      before: "export const value = 1;\n",
      after: "import { game } from '../game/index';\nexport const value = game;\n",
    },
    {
      path: ".github/workflows/ci.yml",
      status: "modified",
      binary: false,
      before: "old",
      after: "new",
    },
  ];
  const findings = engine.analyze(
    changes,
    {
      verification: [],
      boundaries: [
        { name: "input-isolation", from: "src/input/**", cannotImport: ["src/game/**"] },
      ],
      diffExpansionThreshold: 20,
    },
    [],
    "2026-01-01T00:00:00.000Z",
  );
  assert.deepEqual(
    findings.filter((finding) => finding.status === "open").map((finding) => finding.ruleId).sort(),
    [
      "architecture.boundary.input-isolation",
      "change.sensitive-file",
      "dependency.runtime-added",
      "test.assertions-removed",
      "test.excluded-or-focused",
    ],
  );
});

test("preserves accepted findings and resolves missing findings", () => {
  const engine = new AnalysisEngine();
  const changes = [
    {
      path: "package.json",
      status: "modified",
      binary: false,
      before: JSON.stringify({ dependencies: {} }),
      after: JSON.stringify({ dependencies: { leftpad: "1.0.0" } }),
    },
  ];
  const configuration = { verification: [], boundaries: [], diffExpansionThreshold: 15 };
  const initial = engine.analyze(changes, configuration, [], "2026-01-01T00:00:00.000Z");
  initial[0].status = "accepted";
  const stillPresent = engine.analyze(changes, configuration, initial, "2026-01-02T00:00:00.000Z");
  assert.equal(stillPresent[0].status, "accepted");
  const removed = engine.analyze([], configuration, stillPresent, "2026-01-03T00:00:00.000Z");
  assert.equal(removed[0].status, "resolved");
});

test("does not report skip markers that appear only inside strings or comments", () => {
  const findings = new AnalysisEngine().analyze(
    [
      {
        path: "tests/analyzer.test.ts",
        status: "modified",
        binary: false,
        before: "const fixture = '';\n",
        after: "const fixture = \"test.skip('not executable', () => {})\";\n// test.only('comment')\n",
      },
    ],
    { verification: [], boundaries: [], diffExpansionThreshold: 15 },
    [],
  );
  assert.equal(findings.some((finding) => finding.ruleId === "test.excluded-or-focused"), false);
});
