const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

test("uses VibeCheck identifiers for the extension surface", () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
  const icon = readFileSync(join(__dirname, "..", "resources", "vibecheck.svg"), "utf8");

  assert.equal(manifest.name, "vibecheck");
  assert.equal(manifest.displayName, "VibeCheck");
  assert.match(manifest.scripts["package:vsix"], /vibecheck-\$\{npm_package_version\}\.vsix/);
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].id, "vibecheck");
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].icon, "resources/vibecheck.svg");
  assert.ok(manifest.contributes.commands.every(({ command }) => command.startsWith("vibecheck.")));
  assert.ok(Object.keys(manifest.contributes.configuration.properties)
    .every((key) => key.startsWith("vibecheck.")));
  assert.match(icon, /<title[^>]*>VibeCheck<\/title>/);
  assert.match(icon, /M2\.5 12h3l1\.7-3\.7 3\.1 7\.4 2\.4-5\.4 2\.5 4\.1 6\.3-7\.1/);
  assert.doesNotMatch(icon, /<circle/);
});
