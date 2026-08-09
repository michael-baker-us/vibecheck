const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const { ConfigLoader } = require("../dist/config/config-loader");
const {
  ConfigurationSetupService,
  claudeConfigurationSetupArguments,
  codexConfigurationSetupArguments,
  normalizeConfigurationSetupEvent,
} = require("../dist/config/configuration-setup-service");

const selection = {
  provider: "codex",
  profile: "balanced",
  model: "gpt-test",
  effort: "medium",
};

test("passes the selected model and writable managed mode to provider CLIs", () => {
  const codex = codexConfigurationSetupArguments(selection, "configure repository");
  assert.deepEqual(codex.slice(0, 3), ["exec", "--model", "gpt-test"]);
  assert.ok(codex.includes("workspace-write"));
  assert.equal(codex.at(-1), "configure repository");

  const claude = claudeConfigurationSetupArguments({ ...selection, provider: "claude" }, "configure repository");
  assert.ok(claude.includes("gpt-test"));
  assert.ok(claude.includes("acceptEdits"));
  assert.equal(claude.at(-1), "configure repository");
});

test("validates and reports configuration files written by the managed provider", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-setup-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const runner = async (_provider, _args, cwd, _signal, onProgress, onTranscript) => {
    mkdirSync(join(cwd, ".vibecheck"));
    writeFileSync(join(cwd, ".vibecheck", "config.yaml"), [
      "verification:",
      "  - name: tests",
      "    command: npm test",
      "    invalidated_by: [src/**]",
      "",
    ].join("\n"));
    onProgress?.({ label: "Updating .vibecheck files" });
    onTranscript?.({ kind: "tool", label: "Configuration file change" });
  };
  const service = new ConfigurationSetupService(new ConfigLoader(), runner);
  const progress = [];
  const transcript = [];

  const result = await service.run(selection, root, "configure", undefined, (entry) => progress.push(entry), (entry) => transcript.push(entry));

  assert.deepEqual(result.changedFiles, [".vibecheck/config.yaml"]);
  assert.equal(progress[0].label, "Updating .vibecheck files");
  assert.equal(transcript[0].label, "Configuration file change");
});

test("maps provider events to configuration-specific progress", () => {
  assert.deepEqual(
    normalizeConfigurationSetupEvent("codex", { type: "item.completed", item: { type: "file_change" } }),
    { label: "Updating .vibecheck files" },
  );
  assert.deepEqual(
    normalizeConfigurationSetupEvent("claude", { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit" }] } }),
    { label: "Updating .vibecheck files" },
  );
});

test("rejects configuration written to an alternate hidden directory", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-misplaced-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const runner = async (_provider, _args, cwd) => {
    mkdirSync(join(cwd, ".alternate"));
    writeFileSync(join(cwd, ".alternate", "config.yaml"), "verification: []\n");
  };
  const service = new ConfigurationSetupService(new ConfigLoader(), runner);

  await assert.rejects(
    service.run(selection, root, "configure"),
    /outside \.vibecheck\/.*\.alternate\/config\.yaml/,
  );
});
