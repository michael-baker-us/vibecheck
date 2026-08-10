const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const { TeamLoader, bodyPath } = require("../dist/team/team-loader");
const { DEFAULT_TEAM } = require("../dist/team/default-team");

const createRepository = (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-team-loader-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".vibecheck", "agents"), { recursive: true });
  return root;
};

const writeRoster = (root, yaml) => writeFileSync(join(root, ".vibecheck", "team.yaml"), yaml, "utf8");

const VALID = `version: 1
policy:
  provider: prefer-claude
  profile: economy
members:
  - id: cody
    name: Cody
    title: Coder
    description: Use to implement a defined change.
    tier: fast
    tools: editing
    providers: [claude]
    enabled: true
`;

test("returns undefined when the repository has no roster", async (context) => {
  const root = createRepository(context);
  assert.equal(await new TeamLoader().load(root), undefined);
});

test("loads a roster and pairs each member with its body file", async (context) => {
  const root = createRepository(context);
  writeRoster(root, VALID);
  writeFileSync(join(root, bodyPath("cody")), "You are Cody.\n", "utf8");

  const roster = await new TeamLoader().load(root);
  assert.deepEqual(roster.policy, { provider: "prefer-claude", profile: "economy" });
  assert.equal(roster.members.length, 1);
  assert.deepEqual(roster.members[0].providers, ["claude"]);
  assert.equal(roster.members[0].body, "You are Cody.\n");
});

// A member without a body file is still a usable roster entry; the compiler falls back to a
// minimal role statement rather than failing the whole load.
test("tolerates a missing body file", async (context) => {
  const root = createRepository(context);
  writeRoster(root, VALID);
  const roster = await new TeamLoader().load(root);
  assert.equal(roster.members[0].body, "");
});

test("applies defaults for optional fields", async (context) => {
  const root = createRepository(context);
  writeRoster(root, `version: 1
members:
  - id: pam
    name: Pam
    title: Lead
    description: Use for scoping.
    tier: balanced
    tools: read-only
`);
  const roster = await new TeamLoader().load(root);
  assert.deepEqual(roster.policy, { provider: "balanced-auto", profile: "balanced" });
  assert.deepEqual(roster.members[0].providers, ["claude", "codex"]);
  assert.equal(roster.members[0].enabled, true);
});

// Member ids become file names under .claude/agents/, so anything outside the allowlist charset
// must be rejected at load rather than producing an unwritable path later.
test("rejects member ids that would escape the agent path allowlist", async (context) => {
  const root = createRepository(context);
  for (const id of ["../escape", "Cody", "with space", "-leading"]) {
    writeRoster(root, VALID.replace("id: cody", `id: ${JSON.stringify(id)}`));
    await assert.rejects(new TeamLoader().load(root), /must be lowercase letters/);
  }
});

test("rejects malformed rosters with a located message", async (context) => {
  const root = createRepository(context);
  const cases = [
    [VALID.replace("tier: fast", "tier: turbo"), /members\[0\]\.tier must be one of: fast, balanced, deep/],
    [VALID.replace("tools: editing", "tools: everything"), /members\[0\]\.tools must be one of/],
    [VALID.replace("providers: [claude]", "providers: []"), /must list at least one provider/],
    [VALID.replace("providers: [claude]", "providers: [gemini]"), /providers\[0\] must be one of/],
    [VALID.replace("description: Use to implement a defined change.", "description: ''"), /description must be a non-empty string/],
    [VALID.replace("enabled: true", "enabled: yes-please"), /enabled must be true or false/],
    [VALID.replace("version: 1", "version: 4"), /unsupported version 4/],
    ["members: not-a-list\n", /members must be an array/],
    ["- one\n- two\n", /must contain a YAML object/],
  ];
  for (const [yaml, expected] of cases) {
    writeRoster(root, yaml);
    await assert.rejects(new TeamLoader().load(root), expected, yaml.slice(0, 40));
  }
});

test("rejects duplicate member ids", async (context) => {
  const root = createRepository(context);
  writeRoster(root, `${VALID}  - id: cody
    name: Cody Two
    title: Coder
    description: A second member sharing an id.
    tier: fast
    tools: editing
`);
  await assert.rejects(new TeamLoader().load(root), /duplicate member id "cody"/);
});

test("round-trips the seeded team through save and load without loss", async (context) => {
  const root = createRepository(context);
  const loader = new TeamLoader();
  await loader.save(root, DEFAULT_TEAM);

  const loaded = await loader.load(root);
  assert.equal(loaded.members.length, DEFAULT_TEAM.members.length);
  for (const [index, member] of loaded.members.entries()) {
    const original = DEFAULT_TEAM.members[index];
    assert.equal(member.id, original.id);
    assert.equal(member.description, original.description);
    assert.equal(member.tier, original.tier);
    assert.equal(member.tools, original.tools);
    assert.deepEqual(member.providers, original.providers);
    assert.equal(member.body.trim(), original.body.trim());
  }
});

test("removes a member body file", async (context) => {
  const root = createRepository(context);
  const loader = new TeamLoader();
  await loader.save(root, DEFAULT_TEAM);
  await loader.removeBody(root, "cody");

  const roster = await loader.load(root);
  assert.equal(roster.members.find((member) => member.id === "cody").body, "");
});
