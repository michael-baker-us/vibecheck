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
  assert.match(prompt, /Do not invent scripts/);
  assert.match(prompt, /Edit the files directly/);
  assert.match(prompt, /Preserve the existing `diff_expansion_threshold`/);
  assert.match(prompt, /re-read the exact files from disk and parse them/);
  assert.match(prompt, /\.vibecheck\/config\.yaml/);
  assert.doesNotMatch(prompt, /Claude-specific|Codex-specific/);
});
