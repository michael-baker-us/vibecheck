const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const { TeamService } = require("../dist/team/team-service");
const { TeamLoader } = require("../dist/team/team-loader");
const { DEFAULT_TEAM } = require("../dist/team/default-team");
const { TEAM_BLOCK_START, parseTeamWatermark } = require("../dist/team/team-compiler");

const createRepository = (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-team-service-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const backups = join(root, "..", `backups-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(backups, { recursive: true });
  context.after(() => rmSync(backups, { recursive: true, force: true }));
  return { root, backups };
};

const seeded = async (context) => {
  const { root, backups } = createRepository(context);
  const service = new TeamService();
  const roster = await service.seed(root);
  return { root, backups, service, roster };
};

const applyAll = async (service, root, roster, backups) => {
  const preview = await service.preview(root, roster);
  return service.apply(root, preview, backups, await service.orphans(root, roster));
};

test("seeds the default roster and refuses to overwrite an existing one", async (context) => {
  const { root, service, roster } = await seeded(context);
  assert.equal(roster.members.length, 6);
  assert.ok(existsSync(join(root, ".vibecheck", "team.yaml")));
  assert.ok(existsSync(join(root, ".vibecheck", "agents", "cody.md")));
  await assert.rejects(service.seed(root), /already exists/);
});

test("seeding writes no provider files until the roster is applied", async (context) => {
  const { root } = await seeded(context);
  assert.equal(existsSync(join(root, ".claude")), false);
  assert.equal(existsSync(join(root, "AGENTS.md")), false);
});

test("applies the roster to native Claude subagents and the managed AGENTS.md block", async (context) => {
  const { root, backups, service, roster } = await seeded(context);
  const result = await applyAll(service, root, roster, backups);

  assert.equal(result.changedFiles.length, 7);
  assert.deepEqual(readdirSync(join(root, ".claude", "agents")).sort(), [
    "archy.md", "cody.md", "pam.md", "renee.md", "scout.md", "tristan.md",
  ]);
  const instructions = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.ok(instructions.includes(TEAM_BLOCK_START));
  assert.ok(instructions.includes("**Cody**"));
  assert.equal(result.backupDirectory, undefined);
});

test("preserves hand-written AGENTS.md content around the managed block", async (context) => {
  const { root, backups, service, roster } = await seeded(context);
  writeFileSync(join(root, "AGENTS.md"), "# Repository guidance\n\nKeep this.\n", "utf8");
  const result = await applyAll(service, root, roster, backups);

  const instructions = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.ok(instructions.startsWith("# Repository guidance\n\nKeep this."));
  assert.ok(instructions.includes("**Renee**"));
  // The replaced AGENTS.md is recoverable outside the repository.
  const backed = join(result.backupDirectory, "AGENTS.md");
  assert.equal(readFileSync(backed, "utf8"), "# Repository guidance\n\nKeep this.\n");
});

test("reports drift for missing, in-sync, and hand-edited compiled files", async (context) => {
  const { root, backups, service, roster } = await seeded(context);

  const before = await service.status(root, roster);
  assert.ok(before.members.every((entry) => entry.files[0].state === "missing"));
  assert.equal(before.instructions.state, "missing");

  await applyAll(service, root, roster, backups);
  const after = await service.status(root, roster);
  assert.ok(after.members.every((entry) => entry.files[0].state === "in-sync"));
  assert.equal(after.instructions.state, "in-sync");

  writeFileSync(join(root, ".claude", "agents", "cody.md"), "---\nname: cody\n---\nhand edited\n", "utf8");
  const drifted = await service.status(root, roster);
  assert.equal(drifted.members.find((entry) => entry.member.id === "cody").files[0].state, "modified");
});

// A stale preview would silently discard whatever changed underneath it.
test("refuses to apply a preview generated before the file changed", async (context) => {
  const { root, backups, service, roster } = await seeded(context);
  const preview = await service.preview(root, roster);
  writeFileSync(join(root, "AGENTS.md"), "written after the preview\n", "utf8");

  await assert.rejects(
    service.apply(root, preview, backups),
    /AGENTS\.md changed after the preview was generated/,
  );
});

test("re-applying an unchanged roster is a no-op", async (context) => {
  const { root, backups, service, roster } = await seeded(context);
  await applyAll(service, root, roster, backups);
  const result = await applyAll(service, root, roster, backups);
  assert.deepEqual(result.changedFiles, []);
});

test("disabling a member withdraws its compiled subagent and backs it up", async (context) => {
  const { root, backups, service, roster } = await seeded(context);
  await applyAll(service, root, roster, backups);

  const updated = await service.setEnabled(root, roster, "scout", false);
  assert.deepEqual(await service.orphans(root, updated), [".claude/agents/scout.md"]);

  const result = await applyAll(service, root, updated, backups);
  assert.equal(existsSync(join(root, ".claude", "agents", "scout.md")), false);
  assert.ok(result.changedFiles.includes(".claude/agents/scout.md"));
  assert.ok(existsSync(join(result.backupDirectory, ".claude", "agents", "scout.md")));
  assert.ok(!readFileSync(join(root, "AGENTS.md"), "utf8").includes("**Scout**"));
});

test("removing a member deletes its roster entry, body, and compiled file", async (context) => {
  const { root, backups, service, roster } = await seeded(context);
  await applyAll(service, root, roster, backups);

  const updated = await service.remove(root, roster, "tristan");
  assert.equal(updated.members.length, 5);
  assert.equal(existsSync(join(root, ".vibecheck", "agents", "tristan.md")), false);

  await applyAll(service, root, updated, backups);
  assert.equal(existsSync(join(root, ".claude", "agents", "tristan.md")), false);
  assert.equal(await new TeamLoader().load(root).then((next) => next.members.length), 5);
  await assert.rejects(service.remove(root, updated, "tristan"), /No team member with id "tristan"/);
});

// Subagents the user wrote by hand share the directory and must survive roster maintenance.
test("never removes subagent files it did not generate", async (context) => {
  const { root, backups, service, roster } = await seeded(context);
  await applyAll(service, root, roster, backups);
  mkdirSync(join(root, ".claude", "agents"), { recursive: true });
  writeFileSync(join(root, ".claude", "agents", "mine.md"), "---\nname: mine\n---\nMy own agent.\n", "utf8");

  const updated = await service.remove(root, roster, "cody");
  assert.deepEqual(await service.orphans(root, updated), [".claude/agents/cody.md"]);

  await applyAll(service, root, updated, backups);
  assert.ok(existsSync(join(root, ".claude", "agents", "mine.md")));
  assert.equal(existsSync(join(root, ".claude", "agents", "cody.md")), false);
});

test("adds a new member and compiles it with a watermark", async (context) => {
  const { root, backups, service, roster } = await seeded(context);
  const updated = await service.add(root, roster, {
    id: "quinn",
    name: "Quinn",
    title: "Release Manager",
    description: "Use to prepare a release: changelog, version bump, and tag.",
    tier: "balanced",
    tools: "inspection",
    providers: ["claude"],
    enabled: true,
    body: "You are Quinn.",
  });
  await applyAll(service, root, updated, backups);

  const compiled = readFileSync(join(root, ".claude", "agents", "quinn.md"), "utf8");
  assert.equal(parseTeamWatermark(compiled).id, "quinn");
  assert.match(compiled, /model: sonnet/);
  assert.ok(readFileSync(join(root, "AGENTS.md"), "utf8").includes("**Quinn**"));
  await assert.rejects(service.add(root, updated, DEFAULT_TEAM.members[0]), /already exists/);
});
