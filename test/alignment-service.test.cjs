const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const { AgentInstructionAlignmentService } = require("../dist/agent-instructions/alignment-service");

test("creates Claude instructions that import canonical shared guidance", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-alignment-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "AGENTS.md"), "# Shared guidance\n");

  const result = await new AgentInstructionAlignmentService().align(root);

  assert.deepEqual(result, { status: "created-claude", changed: true });
  assert.match(readFileSync(join(root, "CLAUDE.md"), "utf8"), /^@AGENTS\.md\n\n# Claude Code/);
});

test("prepends the shared import without replacing Claude-specific guidance", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-alignment-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "AGENTS.md"), "# Shared guidance\n");
  writeFileSync(join(root, "CLAUDE.md"), "# Claude-only guidance\n\nKeep this content.\n");

  const service = new AgentInstructionAlignmentService();
  assert.deepEqual(await service.align(root), { status: "updated-claude", changed: true });
  assert.equal(
    readFileSync(join(root, "CLAUDE.md"), "utf8"),
    "@AGENTS.md\n\n# Claude-only guidance\n\nKeep this content.\n",
  );
  assert.deepEqual(await service.align(root), { status: "already-aligned", changed: false });
});

test("does not create provider files without canonical AGENTS guidance", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-alignment-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(
    await new AgentInstructionAlignmentService().align(root),
    { status: "missing-agents", changed: false },
  );
});

test("copies one-sided open-standard skills and reports divergent copies", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-alignment-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "AGENTS.md"), "# Shared guidance\n");
  mkdirSync(join(root, ".agents", "skills", "release"), { recursive: true });
  writeFileSync(join(root, ".agents", "skills", "release", "SKILL.md"), "---\nname: release\ndescription: Release safely.\n---\n");
  const service = new AgentInstructionAlignmentService();

  const before = await service.scan(root, "PLAN.md");
  assert.equal(before.items.find((item) => item.id === "skills:release").status, "codex-only");
  assert.equal(before.items.find((item) => item.id === "plans:active").status, "shared");

  const aligned = await service.alignSafe(root);
  assert.equal(aligned.skillsCopiedToClaude, 1);
  assert.equal(readFileSync(join(root, ".claude", "skills", "release", "SKILL.md"), "utf8"), readFileSync(join(root, ".agents", "skills", "release", "SKILL.md"), "utf8"));

  writeFileSync(join(root, ".claude", "skills", "release", "SKILL.md"), "---\nname: release\ndescription: Changed in Claude.\n---\n");
  const drift = await service.scan(root);
  assert.equal(drift.items.find((item) => item.id === "skills:release").status, "conflict");

  const resolved = await service.alignSkill(root, "release", "claude", join(root, "backups"));
  assert.ok(resolved.backupPath);
  assert.match(readFileSync(join(resolved.backupPath, "SKILL.md"), "utf8"), /Release safely/);
  assert.match(readFileSync(join(root, ".agents", "skills", "release", "SKILL.md"), "utf8"), /Changed in Claude/);
});
