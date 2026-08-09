const assert = require("node:assert/strict");
const test = require("node:test");

const { buildConfigurationSetupPrompt } = require("../dist/prompts/configuration-setup-builder");

test("builds a provider-neutral bounded VibeCheck setup prompt", () => {
  const prompt = buildConfigurationSetupPrompt({
    verification: [{ name: "tests", command: "npm test", invalidatedBy: ["src/**"], category: "tests", required: true }],
    boundaries: [{ name: "domain", from: "src/domain/**", cannotImport: ["src/ui/**"] }],
    diffExpansionThreshold: 15,
    plans: { include: ["PLAN.md"] },
  });

  assert.match(prompt, /Configure VibeCheck for this repository/);
  assert.match(prompt, /tests: `npm test` \(tests, required\)/);
  assert.match(prompt, /domain: src\/domain\/\*\* cannot import src\/ui\/\*\*/);
  assert.match(prompt, /Do not modify application code/);
  assert.match(prompt, /Do not invent scripts/);
  assert.match(prompt, /\.intent-loop\/config\.yaml/);
  assert.doesNotMatch(prompt, /Claude-specific|Codex-specific/);
});
