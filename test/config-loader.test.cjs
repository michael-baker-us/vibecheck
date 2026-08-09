const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const { ConfigLoader } = require("../dist/config/config-loader");

test("loads verification and boundary configuration from local YAML", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-config-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".vibecheck"));
  writeFileSync(
    join(root, ".vibecheck", "config.yaml"),
    "plans:\n  include: [PLAN.md, plans/*.md]\n  active: plans/current.md\nverification:\n  - name: tests\n    command: npm test\n    invalidated_by: [src/**, tests/**]\ndiff_expansion_threshold: 8\n",
  );
  writeFileSync(
    join(root, ".vibecheck", "rules.yaml"),
    "boundaries:\n  - name: isolation\n    from: src/input/**\n    cannot_import: [src/game/**]\n",
  );
  assert.deepEqual(await new ConfigLoader().load(root), {
    verification: [{ name: "tests", command: "npm test", invalidatedBy: ["src/**", "tests/**"], required: true }],
    boundaries: [{ name: "isolation", from: "src/input/**", cannotImport: ["src/game/**"] }],
    diffExpansionThreshold: 8,
    plans: { include: ["PLAN.md", "plans/*.md"], active: "plans/current.md" },
  });
});
