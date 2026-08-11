const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
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
  return root;
};

const seeded = async (context) => {
  const root = createRepository(context);
  const service = new TeamService();
  const roster = await service.seed(root);
  return { root, service, roster };
};

const deploy = (service, root, roster) => service.deploy(root, roster);

test("seeds the default roster and refuses to overwrite an existing one", async (context) => {
  const { root, service, roster } = await seeded(context);
  assert.equal(roster.members.length, 6);
  assert.ok(existsSync(join(root, ".vibecheck", "team.yaml")));
  // Role prompts are not duplicated into .vibecheck/; they live only in the subagent files.
  assert.equal(existsSync(join(root, ".vibecheck", "agents")), false);
  await assert.rejects(service.seed(root), /already exists/);
});

test("seeding writes no provider files until the roster is applied", async (context) => {
  const { root } = await seeded(context);
  assert.equal(existsSync(join(root, ".claude")), false);
  assert.equal(existsSync(join(root, "AGENTS.md")), false);
});

test("restores removed default members without replacing existing roster entries", async (context) => {
  const { root, service, roster } = await seeded(context);
  const customized = {
    ...roster,
    members: [
      { ...roster.members.find((member) => member.id === "cody"), name: "Custom Cody" },
      {
        id: "quinn",
        name: "Quinn",
        title: "Release Manager",
        description: "Use to prepare releases while preserving the repository's release conventions.",
        tier: "balanced",
        tools: "inspection",
        providers: ["claude"],
        enabled: true,
      },
    ],
  };
  await new TeamLoader().save(root, customized);

  const restored = await service.restoreDefaults(root, customized);

  assert.equal(restored.members.length, 7);
  assert.equal(restored.members.find((member) => member.id === "cody").name, "Custom Cody");
  assert.ok(restored.members.some((member) => member.id === "quinn"));
  assert.deepEqual(
    restored.members.filter((member) => DEFAULT_TEAM.members.some((item) => item.id === member.id)).map((member) => member.id).sort(),
    DEFAULT_TEAM.members.map((member) => member.id).sort(),
  );

  await deploy(service, root, restored);
  assert.ok(existsSync(join(root, ".claude", "agents", "pam.md")));
  assert.ok(readFileSync(join(root, "AGENTS.md"), "utf8").includes("**Pam**"));
});

test("applies the roster to native Claude subagents and the managed AGENTS.md block", async (context) => {
  const { root, service, roster } = await seeded(context);
  const result = await deploy(service, root, roster);

  assert.equal(result.changedFiles.length, 7);
  assert.deepEqual(readdirSync(join(root, ".claude", "agents")).sort(), [
    "archy.md", "cody.md", "pam.md", "renee.md", "scout.md", "tristan.md",
  ]);
  const instructions = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.ok(instructions.includes(TEAM_BLOCK_START));
  assert.ok(instructions.includes("**Cody**"));
});

test("preserves hand-written AGENTS.md content around the managed block", async (context) => {
  const { root, service, roster } = await seeded(context);
  writeFileSync(join(root, "AGENTS.md"), "# Repository guidance\n\nKeep this.\n", "utf8");
  await deploy(service, root, roster);

  const instructions = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.ok(instructions.startsWith("# Repository guidance\n\nKeep this."));
  assert.ok(instructions.includes("**Renee**"));
});

test("reports drift for missing, in-sync, and hand-edited compiled files", async (context) => {
  const { root, service, roster } = await seeded(context);

  const before = await service.status(root, roster);
  assert.ok(before.members.every((entry) => entry.files[0].state === "missing"));
  assert.equal(before.instructions.state, "missing");

  await deploy(service, root, roster);
  const after = await service.status(root, roster);
  assert.ok(after.members.every((entry) => entry.files[0].state === "in-sync"));
  assert.equal(after.instructions.state, "in-sync");

  writeFileSync(join(root, ".claude", "agents", "cody.md"), "---\nname: cody\n---\nhand edited\n", "utf8");
  const drifted = await service.status(root, roster);
  assert.equal(drifted.members.find((entry) => entry.member.id === "cody").files[0].state, "modified");
});

test("re-deploying an unchanged roster is a no-op", async (context) => {
  const { root, service, roster } = await seeded(context);
  await deploy(service, root, roster);
  const result = await deploy(service, root, roster);
  assert.deepEqual(result.changedFiles, []);
});

test("disabling a member withdraws its compiled subagent", async (context) => {
  const { root, service, roster } = await seeded(context);
  await deploy(service, root, roster);

  const updated = await service.setEnabled(root, roster, "scout", false);
  assert.deepEqual(await service.orphans(root, updated), [".claude/agents/scout.md"]);

  const result = await deploy(service, root, updated);
  assert.equal(existsSync(join(root, ".claude", "agents", "scout.md")), false);
  assert.ok(result.changedFiles.includes(".claude/agents/scout.md"));
  assert.ok(!readFileSync(join(root, "AGENTS.md"), "utf8").includes("**Scout**"));
});

test("removing a member deletes its roster entry and its subagent file", async (context) => {
  const { root, service, roster } = await seeded(context);
  await deploy(service, root, roster);

  const updated = await service.remove(root, roster, "tristan");
  assert.equal(updated.members.length, 5);

  await deploy(service, root, updated);
  assert.equal(existsSync(join(root, ".claude", "agents", "tristan.md")), false);
  assert.equal(await new TeamLoader().load(root).then((next) => next.members.length), 5);
  await assert.rejects(service.remove(root, updated, "tristan"), /No team member with id "tristan"/);
});

// The role prompt exists in exactly one place now, so a roster edit that rewrites frontmatter must
// not cost the user the prompt they wrote.
test("keeps the authored role prompt across roster edits", async (context) => {
  const { root, service, roster } = await seeded(context);
  await deploy(service, root, roster);

  const file = join(root, ".claude", "agents", "cody.md");
  const edited = readFileSync(file, "utf8").replace(
    "You are Cody, the implementer for this repository.",
    "You are Cody.\n\n## House rules\n\n- Never touch the vendored directory.",
  );
  writeFileSync(file, edited, "utf8");

  const updated = await service.setEnabled(root, roster, "cody", true);
  const promoted = await service.remove(root, updated, "scout");
  await deploy(service, root, promoted);

  const after = readFileSync(file, "utf8");
  assert.ok(after.includes("- Never touch the vendored directory."), "authored body must survive");
  assert.equal(parseTeamWatermark(after).id, "cody");
});

// Repositories seeded by 0.7.0 keep their prompts in .vibecheck/agents/. Those must migrate into
// the subagent file rather than being silently replaced by the defaults.
test("migrates legacy role prompts and then removes them", async (context) => {
  const { root, service, roster } = await seeded(context);
  mkdirSync(join(root, ".vibecheck", "agents"), { recursive: true });
  writeFileSync(join(root, ".vibecheck", "agents", "cody.md"), "Legacy Cody prompt.\n", "utf8");

  assert.deepEqual(await service.legacyBodies(root, roster), [".vibecheck/agents/cody.md"]);
  const result = await deploy(service, root, roster);

  assert.ok(readFileSync(join(root, ".claude", "agents", "cody.md"), "utf8").includes("Legacy Cody prompt."));
  assert.equal(existsSync(join(root, ".vibecheck", "agents", "cody.md")), false);
  assert.ok(result.changedFiles.includes(".vibecheck/agents/cody.md"));
  assert.deepEqual(await service.legacyBodies(root, roster), []);
});

// Subagents the user wrote by hand share the directory and must survive roster maintenance.
test("never removes subagent files it did not generate", async (context) => {
  const { root, service, roster } = await seeded(context);
  await deploy(service, root, roster);
  mkdirSync(join(root, ".claude", "agents"), { recursive: true });
  writeFileSync(join(root, ".claude", "agents", "mine.md"), "---\nname: mine\n---\nMy own agent.\n", "utf8");

  const updated = await service.remove(root, roster, "cody");
  assert.deepEqual(await service.orphans(root, updated), [".claude/agents/cody.md"]);

  await deploy(service, root, updated);
  assert.ok(existsSync(join(root, ".claude", "agents", "mine.md")));
  assert.equal(existsSync(join(root, ".claude", "agents", "cody.md")), false);
});

test("undeploy removes generated files and managed instructions while retaining the roster", async (context) => {
  const { root, service, roster } = await seeded(context);
  writeFileSync(join(root, "AGENTS.md"), "# Guidance\n\nKeep this.\n", "utf8");
  await deploy(service, root, roster);
  writeFileSync(join(root, ".claude", "agents", "mine.md"), "---\nname: mine\n---\nHand authored.\n", "utf8");

  const result = await service.undeploy(root);

  assert.equal(result.changedFiles.length, 7);
  assert.ok(existsSync(join(root, ".vibecheck", "team.yaml")));
  assert.ok(existsSync(join(root, ".claude", "agents", "mine.md")));
  assert.equal(existsSync(join(root, ".claude", "agents", "cody.md")), false);
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), "# Guidance\n\nKeep this.\n");
});

test("rejects a symlinked instructions target during deploy", async (context) => {
  const { root, service, roster } = await seeded(context);
  const outside = join(root, "outside.md");
  writeFileSync(outside, "outside\n", "utf8");
  symlinkSync(outside, join(root, "AGENTS.md"));
  await assert.rejects(service.deploy(root, roster), /unsafe team file: AGENTS\.md/);
  assert.equal(readFileSync(outside, "utf8"), "outside\n");
});

test("rejects symlinked agent directories and generated agent files", async (context) => {
  const { root, service, roster } = await seeded(context);
  const outsideDirectory = join(root, "outside-agents");
  mkdirSync(outsideDirectory);
  mkdirSync(join(root, ".claude"));
  symlinkSync(outsideDirectory, join(root, ".claude", "agents"));
  await assert.rejects(service.deploy(root, roster), /unsafe team directory: \.claude\/agents/);

  rmSync(join(root, ".claude", "agents"));
  await deploy(service, root, roster);
  const outside = join(root, "outside-agent.md");
  writeFileSync(outside, "outside\n", "utf8");
  rmSync(join(root, ".claude", "agents", "cody.md"));
  symlinkSync(outside, join(root, ".claude", "agents", "cody.md"));
  await assert.rejects(service.undeploy(root), /unsafe team file: \.claude\/agents\/cody\.md/);
  assert.equal(readFileSync(outside, "utf8"), "outside\n");
});

test("undeploy deletes every watermarked team file it finds", async (context) => {
  const { root, service, roster } = await seeded(context);
  await deploy(service, root, roster);
  const cody = readFileSync(join(root, ".claude", "agents", "cody.md"), "utf8");
  writeFileSync(join(root, ".claude", "agents", "new-generated.md"), cody, "utf8");

  const result = await service.undeploy(root);
  assert.ok(result.changedFiles.includes(".claude/agents/new-generated.md"));
  assert.equal(existsSync(join(root, ".claude", "agents", "new-generated.md")), false);
  assert.equal(existsSync(join(root, ".claude", "agents", "cody.md")), false);
});

test("redeploy recreates deleted role files from the roster defaults", async (context) => {
  const { root, service, roster } = await seeded(context);
  await deploy(service, root, roster);
  const codyPath = join(root, ".claude", "agents", "cody.md");
  writeFileSync(codyPath, readFileSync(codyPath, "utf8").replace(
    "You are Cody, the implementer for this repository.",
    "You are Cody. Preserve this custom role body across undeployment.",
  ), "utf8");

  await service.undeploy(root);
  assert.equal(existsSync(codyPath), false);

  await service.deploy(root, roster);
  assert.match(readFileSync(codyPath, "utf8"), /You are Cody, the implementer for this repository/);
});

test("adds a new member and compiles it with a watermark", async (context) => {
  const { root, service, roster } = await seeded(context);
  const updated = await service.add(root, roster, {
    id: "quinn",
    name: "Quinn",
    title: "Release Manager",
    description: "Use to prepare a release: changelog, version bump, and tag.",
    tier: "balanced",
    tools: "inspection",
    providers: ["claude"],
    enabled: true,
  });
  await deploy(service, root, updated);

  const compiled = readFileSync(join(root, ".claude", "agents", "quinn.md"), "utf8");
  assert.equal(parseTeamWatermark(compiled).id, "quinn");
  assert.match(compiled, /model: sonnet/);
  assert.ok(compiled.includes("You are Quinn"), "a new member gets a starting prompt to edit");
  assert.ok(readFileSync(join(root, "AGENTS.md"), "utf8").includes("**Quinn**"));
  await assert.rejects(service.add(root, updated, DEFAULT_TEAM.members[0]), /already exists/);
});
