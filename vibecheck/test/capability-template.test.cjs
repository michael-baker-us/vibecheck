const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildAgentCapabilityTemplate,
  isAgentCapabilityTemplateId,
} = require("../dist/agent-instructions/capability-template");

const templateIds = [
  "instructions", "skills", "codex-settings", "codex-rules", "codex-agents", "codex-hooks", "codex-mcp",
  "claude-settings", "claude-rules", "claude-agents", "claude-hooks", "claude-mcp", "claude-output-styles",
];

test("builds editable, non-writing working templates for every catalog capability", () => {
  for (const id of templateIds) {
    assert.equal(isAgentCapabilityTemplateId(id), true);
    const template = buildAgentCapabilityTemplate(id);
    assert.match(template, /VibeCheck has not created or changed any repository files/);
    assert.match(template, /## Working brief/);
    assert.match(template, /## Minimal format example/);
    assert.match(template, /## Suggested agent handoff/);
  }
  assert.equal(isAgentCapabilityTemplateId("unsupported"), false);
});

test("uses current provider-native paths in capability examples", () => {
  assert.match(buildAgentCapabilityTemplate("skills"), /\.agents\/skills\/<skill-name>\/SKILL\.md/);
  assert.match(buildAgentCapabilityTemplate("skills"), /\.claude\/skills\/<skill-name>\/SKILL\.md/);
  assert.match(buildAgentCapabilityTemplate("codex-agents"), /\.codex\/agents\/<agent-name>\.toml/);
  assert.match(buildAgentCapabilityTemplate("claude-agents"), /\.claude\/agents\/<agent-name>\.md/);
  assert.match(buildAgentCapabilityTemplate("claude-mcp"), /\.mcp\.json/);
});
