const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

test("uses VibeCheck identifiers for the extension surface", () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

  assert.equal(manifest.name, "vibecheck");
  assert.equal(manifest.displayName, "VibeCheck");
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].id, "vibecheck");
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].icon, "resources/vibecheck.svg");
  assert.ok(manifest.contributes.commands.every(({ command }) => command.startsWith("vibecheck.")));
  assert.ok(Object.keys(manifest.contributes.configuration.properties)
    .every((key) => key.startsWith("vibecheck.")));
});
