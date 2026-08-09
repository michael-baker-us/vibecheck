const assert = require("node:assert/strict");
const test = require("node:test");

const { buildConfigurationSetupPrompt } = require("../dist/prompts/configuration-setup-builder");

test("builds a provider-neutral bounded VibeCheck setup prompt", () => {
  const prompt = buildConfigurationSetupPrompt({
    verification: [{ name: "tests", command: "npm test", invalidatedBy: ["src/**"], category: "tests", required: true }],
    boundaries: [{ name: "domain", from: "src/domain/**", cannotImport: ["src/ui/**"] }],
    diffExpansionThreshold: 15,
    plans: { include: ["PLAN.md"] },
  }, true);

  assert.match(prompt, /Audit and update VibeCheck for this repository/);
  assert.match(prompt, /do not regenerate it from scratch/);
  assert.match(prompt, /tests: `npm test` \(tests, required\)/);
  assert.match(prompt, /domain: src\/domain\/\*\* cannot import src\/ui\/\*\*/);
  assert.match(prompt, /Do not modify application code/);
  assert.match(prompt, /Do not add package scripts, install packages, add dependencies/);
  assert.match(prompt, /Edit the files directly/);
  assert.match(prompt, /only VibeCheck configuration directory/);
  assert.match(prompt, /Preserve the existing `diff_expansion_threshold`/);
  assert.match(prompt, /re-read the exact files from disk to confirm their content/);
  assert.match(prompt, /\.vibecheck\/config\.yaml/);
  assert.doesNotMatch(prompt, /Claude-specific|Codex-specific/);
});

test("directs the agent to configure a security gate that needs no package script", () => {
  const prompt = buildConfigurationSetupPrompt({
    verification: [],
    boundaries: [],
    diffExpansionThreshold: 15,
    plans: { include: ["PLAN.md"] },
  });

  // A repository with only `test` and `build` scripts still supports `npm audit`, which is why
  // security gates were being omitted entirely.
  assert.match(prompt, /npm audit --json --audit-level=high/);
  assert.match(prompt, /does not have to be a package script/);
  assert.match(prompt, /tests, coverage, and dependency security/);
  assert.doesNotMatch(prompt, /Do not invent scripts, install packages/);
});

test("requires an explicit explanation when a recommended gate is left unconfigured", () => {
  const prompt = buildConfigurationSetupPrompt({
    verification: [],
    boundaries: [],
    diffExpansionThreshold: 15,
    plans: { include: ["PLAN.md"] },
  });
  assert.match(prompt, /the single change that\s+would enable it/);
  assert.match(prompt, /Do not silently omit it/);
});
