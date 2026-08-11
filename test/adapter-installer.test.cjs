const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const { AdapterInstaller } = require("../dist/adapters/adapter-installer");

test("installs and removes agent hooks without replacing existing configuration", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-adapter-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const bridge = join(root, "source-bridge.cjs");
  writeFileSync(bridge, "process.exit(0);\n");
  const installer = new AdapterInstaller(bridge, root);

  assert.deepEqual(await installer.installationStatus(), { codex: false, claude: false });

  const codexPath = await installer.install("codex");
  const installed = JSON.parse(readFileSync(codexPath, "utf8"));
  assert.equal(installed.hooks.SessionStart.length, 1);
  assert.equal(installed.hooks.PostToolUse[0].matcher, "*");
  assert.match(installed.hooks.SessionStart[0].hooks[0].command, /hook-bridge\.cjs.*codex/);
  assert.equal(await installer.isInstalled("codex"), true);
  assert.deepEqual(await installer.installationStatus(), { codex: true, claude: false });

  await installer.install("codex");
  const installedAgain = JSON.parse(readFileSync(codexPath, "utf8"));
  assert.equal(installedAgain.hooks.SessionStart.length, 1);

  await installer.uninstall("codex");
  const removed = JSON.parse(readFileSync(codexPath, "utf8"));
  assert.equal(removed.hooks, undefined);
  assert.equal(await installer.isInstalled("codex"), false);
});

test("does not report a partial hook configuration as installed", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-adapter-status-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const bridge = join(root, "source-bridge.cjs");
  writeFileSync(bridge, "process.exit(0);\n");
  const installer = new AdapterInstaller(bridge, root);
  const configPath = installer.configPath("codex");
  mkdirSync(join(root, ".codex"), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: `node \"${join(root, ".vibecheck", "bin", "hook-bridge.cjs")}\" codex` }] }] } }));

  assert.equal(await installer.isInstalled("codex"), false);
  assert.equal(await installer.hasConfiguredHooks("codex"), true, "partial legacy hooks still require cleanup");
  await installer.uninstall("codex");
  assert.equal(await installer.hasConfiguredHooks("codex"), false);
});

test("requires the installed bridge to remain a regular file", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-adapter-bridge-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const bridge = join(root, "source-bridge.cjs");
  writeFileSync(bridge, "process.exit(0);\n");
  const installer = new AdapterInstaller(bridge, root);
  await installer.install("codex");
  rmSync(join(root, ".vibecheck", "bin", "hook-bridge.cjs"));

  assert.equal(await installer.isInstalled("codex"), false);
});

test("requires matched hook handlers to use the command type", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-adapter-handler-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const bridge = join(root, "source-bridge.cjs");
  writeFileSync(bridge, "process.exit(0);\n");
  const installer = new AdapterInstaller(bridge, root);
  const configPath = await installer.install("codex");
  const configuration = JSON.parse(readFileSync(configPath, "utf8"));
  configuration.hooks.SessionStart[0].hooks[0].type = "prompt";
  writeFileSync(configPath, JSON.stringify(configuration));

  assert.equal(await installer.isInstalled("codex"), false);

  await installer.install("codex");
  const repaired = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(repaired.hooks.SessionStart[0].hooks[0].type, "command");
  assert.equal(repaired.hooks.SessionStart[0].hooks[0].timeout, 10);
  assert.equal(await installer.isInstalled("codex"), true);
});
