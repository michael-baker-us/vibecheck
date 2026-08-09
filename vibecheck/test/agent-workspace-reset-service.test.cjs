const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const { AgentWorkspaceResetService } = require("../dist/agent-instructions/reset-service");

test("backs up and removes the selected Agent Workspace files", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-workspace-reset-"));
  const backups = mkdtempSync(join(tmpdir(), "vibecheck-workspace-reset-backups-"));
  context.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(backups, { recursive: true, force: true });
  });
  mkdirSync(join(root, ".agents", "skills", "review"), { recursive: true });
  mkdirSync(join(root, ".vibecheck"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "# Shared guidance\n");
  writeFileSync(join(root, ".agents", "skills", "review", "SKILL.md"), "# Review skill\n");
  writeFileSync(join(root, ".vibecheck", "config.yaml"), "plans: {}\n");

  const result = await new AgentWorkspaceResetService().reset(
    root,
    ["AGENTS.md", ".agents/skills/review/SKILL.md", "AGENTS.md", "CLAUDE.md"],
    backups,
  );

  assert.deepEqual(result.removedFiles, [".agents/skills/review/SKILL.md", "AGENTS.md"]);
  assert.equal(existsSync(join(root, "AGENTS.md")), false);
  assert.equal(existsSync(join(root, ".agents", "skills", "review", "SKILL.md")), false);
  assert.equal(readFileSync(join(result.backupDirectory, "AGENTS.md"), "utf8"), "# Shared guidance\n");
  assert.equal(readFileSync(join(result.backupDirectory, ".agents", "skills", "review", "SKILL.md"), "utf8"), "# Review skill\n");
  assert.equal(readFileSync(join(root, ".vibecheck", "config.yaml"), "utf8"), "plans: {}\n");
});

test("does nothing when none of the selected files exist", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-workspace-reset-empty-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(await new AgentWorkspaceResetService().reset(root, ["AGENTS.md"], join(root, "backups")), {
    removedFiles: [],
  });
});

test("rejects paths outside the repository and symbolic links", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-workspace-reset-safe-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const service = new AgentWorkspaceResetService();

  await assert.rejects(service.reset(root, ["../AGENTS.md"], join(root, "backups")), /Invalid Agent Workspace path/);
  writeFileSync(join(root, "target.md"), "target\n");
  symlinkSync(join(root, "target.md"), join(root, "AGENTS.md"));
  await assert.rejects(service.reset(root, ["AGENTS.md"], join(root, "backups")), /not a regular repository file/);
  assert.equal(readFileSync(join(root, "target.md"), "utf8"), "target\n");
});
