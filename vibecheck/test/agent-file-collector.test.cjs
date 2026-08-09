const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const { AgentFileCollector } = require("../dist/collectors/agent-file-collector");

test("discovers standard Codex and Claude repository files without reading their contents", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-agent-files-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, ".claude", "rules"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "# Instructions\n");
  writeFileSync(join(root, "src", "AGENTS.override.md"), "# Override\n");
  writeFileSync(join(root, ".claude", "rules", "testing.md"), "# Tests\n");
  const files = ["AGENTS.md", "src/AGENTS.override.md", ".claude/rules/testing.md"];
  const collector = new AgentFileCollector({ listRepositoryFiles: async () => files });
  const result = await collector.collect(root);

  assert.equal(result.find((file) => file.path === "AGENTS.md").exists, true);
  assert.equal(result.find((file) => file.path === "CLAUDE.md").exists, false);
  assert.equal(result.find((file) => file.path === "src/AGENTS.override.md").owner, "codex");
  assert.equal(result.find((file) => file.path === ".claude/rules/testing.md").kind, "rules");
});

test("inventories repository capabilities supported by Codex and Claude", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-agent-capabilities-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const files = [
    ".agents/skills/release/SKILL.md",
    ".codex/agents/explorer.toml",
    ".codex/hooks.json",
    ".codex/rules/team.rules",
    "packages/api/.codex/config.toml",
    "tools/codex-plugin/.codex-plugin/plugin.json",
    "tools/codex-plugin/skills/triage/SKILL.md",
    "tools/codex-plugin/hooks/hooks.json",
    "tools/codex-plugin/.mcp.json",
    "tools/codex-plugin/.app.json",
    ".claude/skills/release/SKILL.md",
    ".claude/commands/release.md",
    ".claude/agents/security.md",
    ".claude/output-styles/concise.md",
    ".mcp.json",
    "tools/claude-plugin/.claude-plugin/plugin.json",
    "tools/claude-plugin/skills/triage/SKILL.md",
    "tools/claude-plugin/agents/reviewer.md",
    "tools/claude-plugin/hooks/hooks.json",
    "tools/claude-plugin/.mcp.json",
  ];
  for (const file of files) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "{}\n");
  }
  const collector = new AgentFileCollector({ listRepositoryFiles: async () => files });
  const result = await collector.collect(root);
  const actual = new Map(result.filter((file) => files.includes(file.path)).map((file) => [file.path, [file.owner, file.kind]]));

  assert.deepEqual(actual.get(".agents/skills/release/SKILL.md"), ["codex", "skills"]);
  assert.deepEqual(actual.get(".codex/agents/explorer.toml"), ["codex", "agents"]);
  assert.deepEqual(actual.get(".codex/hooks.json"), ["codex", "hooks"]);
  assert.deepEqual(actual.get(".codex/rules/team.rules"), ["codex", "rules"]);
  assert.deepEqual(actual.get("packages/api/.codex/config.toml"), ["codex", "settings"]);
  assert.deepEqual(actual.get("tools/codex-plugin/.codex-plugin/plugin.json"), ["codex", "plugins"]);
  assert.deepEqual(actual.get("tools/codex-plugin/skills/triage/SKILL.md"), ["codex", "skills"]);
  assert.deepEqual(actual.get("tools/codex-plugin/hooks/hooks.json"), ["codex", "hooks"]);
  assert.deepEqual(actual.get("tools/codex-plugin/.mcp.json"), ["codex", "mcp"]);
  assert.deepEqual(actual.get("tools/codex-plugin/.app.json"), ["codex", "mcp"]);
  assert.deepEqual(actual.get(".claude/skills/release/SKILL.md"), ["claude", "skills"]);
  assert.deepEqual(actual.get(".claude/commands/release.md"), ["claude", "prompts"]);
  assert.deepEqual(actual.get(".claude/agents/security.md"), ["claude", "agents"]);
  assert.deepEqual(actual.get(".claude/output-styles/concise.md"), ["claude", "output-styles"]);
  assert.deepEqual(actual.get(".mcp.json"), ["claude", "mcp"]);
  assert.deepEqual(actual.get("tools/claude-plugin/.claude-plugin/plugin.json"), ["claude", "plugins"]);
  assert.deepEqual(actual.get("tools/claude-plugin/skills/triage/SKILL.md"), ["claude", "skills"]);
  assert.deepEqual(actual.get("tools/claude-plugin/agents/reviewer.md"), ["claude", "agents"]);
  assert.deepEqual(actual.get("tools/claude-plugin/hooks/hooks.json"), ["claude", "hooks"]);
  assert.deepEqual(actual.get("tools/claude-plugin/.mcp.json"), ["claude", "mcp"]);
});
