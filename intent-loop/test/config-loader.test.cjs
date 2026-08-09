const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const { ConfigLoader } = require("../dist/config/config-loader");

test("loads verification and boundary configuration from local YAML", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "intent-loop-config-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".intent-loop"));
  writeFileSync(
    join(root, ".intent-loop", "config.yaml"),
    "verification:\n  - name: tests\n    command: npm test\n    invalidated_by: [src/**, tests/**]\ndiff_expansion_threshold: 8\n",
  );
  writeFileSync(
    join(root, ".intent-loop", "rules.yaml"),
    "boundaries:\n  - name: isolation\n    from: src/input/**\n    cannot_import: [src/game/**]\n",
  );
  assert.deepEqual(await new ConfigLoader().load(root), {
    verification: [{ name: "tests", command: "npm test", invalidatedBy: ["src/**", "tests/**"], required: true }],
    boundaries: [{ name: "isolation", from: "src/input/**", cannotImport: ["src/game/**"] }],
    diffExpansionThreshold: 8,
  });
});
