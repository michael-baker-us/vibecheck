const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const { AgentFileCollector } = require("../dist/collectors/agent-file-collector");

test("discovers standard Codex and Claude repository files without reading their contents", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "intent-loop-agent-files-"));
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
