const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const { AdapterInstaller } = require("../dist/adapters/adapter-installer");

test("installs and removes agent hooks without replacing existing configuration", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "intent-loop-adapter-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const bridge = join(root, "source-bridge.cjs");
  writeFileSync(bridge, "process.exit(0);\n");
  const installer = new AdapterInstaller(bridge, root);

  const codexPath = await installer.install("codex");
  const installed = JSON.parse(readFileSync(codexPath, "utf8"));
  assert.equal(installed.hooks.SessionStart.length, 1);
  assert.equal(installed.hooks.PostToolUse[0].matcher, "*");
  assert.match(installed.hooks.SessionStart[0].hooks[0].command, /hook-bridge\.cjs.*codex/);

  await installer.install("codex");
  const installedAgain = JSON.parse(readFileSync(codexPath, "utf8"));
  assert.equal(installedAgain.hooks.SessionStart.length, 1);

  await installer.uninstall("codex");
  const removed = JSON.parse(readFileSync(codexPath, "utf8"));
  assert.equal(removed.hooks, undefined);
});
