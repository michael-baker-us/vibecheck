const assert = require("node:assert/strict");
const test = require("node:test");

const {
  TEAM_BLOCK_END,
  TEAM_BLOCK_START,
  applyTeamBlock,
  claudeAgentPath,
  compileClaudeAgent,
  compileRoster,
  compileTeamBlock,
  enabledMembers,
  extractBody,
  memberFingerprint,
  parseTeamWatermark,
  readTeamBlock,
  rosterMembers,
} = require("../dist/team/team-compiler");
const { isAllowedWorkspacePath } = require("../dist/agent-instructions/refresh-service");
const { DEFAULT_BODIES, DEFAULT_TEAM } = require("../dist/team/default-team");

const member = (overrides = {}) => ({
  id: "cody",
  name: "Cody",
  title: "Coder",
  description: "Use to implement a defined change.",
  tier: "fast",
  tools: "editing",
  providers: ["claude", "codex"],
  enabled: true,
  ...overrides,
});

const roster = (members, policy = {}) => ({
  version: 1,
  policy: { provider: "balanced-auto", profile: "balanced", ...policy },
  members,
});

test("compiles a member into a native Claude subagent with generated frontmatter", () => {
  const content = compileClaudeAgent(member(), undefined, "You are Cody.");
  assert.match(content, /^---\nname: cody\n/);
  assert.match(content, /description: "Use to implement a defined change\."/);
  assert.match(content, /model: haiku\n/);
  assert.match(content, /tools: "Read,Grep,Glob,Write,Edit,/);
  assert.ok(content.trimEnd().endsWith("You are Cody."));
});

test("maps tool profiles and tiers onto the shared Claude permission lists", () => {
  assert.match(compileClaudeAgent(member({ tools: "read-only" })).split("\n")[3], /^tools: "Read,Grep,Glob,Bash/);
  assert.ok(!compileClaudeAgent(member({ tools: "read-only" })).includes("Write,Edit"));
  assert.ok(compileClaudeAgent(member({ tools: "inspection" })).includes("Bash(npm run *)"));
  assert.ok(!compileClaudeAgent(member({ tools: "inspection" })).includes("Write,Edit"));

  assert.match(compileClaudeAgent(member({ tier: "balanced" })), /model: sonnet/);
  assert.match(compileClaudeAgent(member({ tier: "deep" })), /model: opus/);
});

// Prose descriptions routinely contain colons and quotes, both of which change meaning in
// unquoted YAML and would silently corrupt the generated frontmatter.
test("quotes frontmatter values so prose cannot break the YAML", () => {
  const content = compileClaudeAgent(member({
    description: 'Use when: the "obvious" fix fails.\nSecond line.',
  }));
  assert.ok(content.includes('description: "Use when: the \\"obvious\\" fix fails. Second line."'));
  const frontmatter = content.split("---")[1];
  assert.equal(frontmatter.split("\n").filter((line) => line.startsWith("description")).length, 1);
});

test("compilation is deterministic for an unchanged roster", () => {
  const first = compileRoster(roster([member()]), "# Repo\n");
  const second = compileRoster(roster([member()]), "# Repo\n");
  assert.deepEqual(first, second);
});

test("watermarks each compiled agent with the roster fields it came from", () => {
  const content = compileClaudeAgent(member());
  const watermark = parseTeamWatermark(content);
  assert.equal(watermark.id, "cody");
  assert.equal(watermark.hash, memberFingerprint(member()));

  // Only generated frontmatter participates. The body is authored in place, so editing it must
  // never be reported as drift.
  assert.equal(memberFingerprint(member({ name: "Codey" })), watermark.hash);
  assert.notEqual(memberFingerprint(member({ tier: "deep" })), watermark.hash);
  assert.notEqual(memberFingerprint(member({ tools: "read-only" })), watermark.hash);
});

// The role prompt is authored in the subagent file and stored nowhere else, so a roster edit must
// rewrite the frontmatter and carry the body through untouched.
test("preserves the authored body when regenerating frontmatter", () => {
  const authored = "You are Cody.\n\n## House rules\n\n- Never touch the vendored directory.";
  const first = compileClaudeAgent(member(), undefined, authored);
  const regenerated = compileClaudeAgent(member({ tier: "deep" }), first);

  assert.match(regenerated, /model: opus/);
  assert.ok(regenerated.includes("- Never touch the vendored directory."));
  assert.equal(extractBody(regenerated), authored);
  // Recompiling an unchanged member is byte-stable, so apply stays a no-op.
  assert.equal(compileClaudeAgent(member(), first, authored), first);
});

test("extracts the body from hand-written and generated subagent files alike", () => {
  assert.equal(extractBody("---\nname: x\n---\n\nBody text.\n"), "Body text.");
  assert.equal(extractBody("Body only, no frontmatter.\n"), "Body only, no frontmatter.");
  assert.equal(
    extractBody("---\nname: x\n---\n<!-- vibecheck-team: id=x; hash=0123456789abcdef -->\n\nBody.\n"),
    "Body.",
  );
});

// Adopting an existing hand-written subagent into the roster must not discard its instructions.
test("keeps a hand-written subagent body when the member joins the roster", () => {
  const handWritten = "---\nname: cody\ndescription: mine\n---\n\nMy own careful instructions.\n";
  const compiled = compileClaudeAgent(member(), handWritten);
  assert.equal(extractBody(compiled), "My own careful instructions.");
  assert.match(compiled, /description: "Use to implement a defined change\."/);
});

test("generated agent paths satisfy the Agent Workspace allowlist", () => {
  for (const file of compileRoster(DEFAULT_TEAM, "# Repo\n")) {
    assert.ok(isAllowedWorkspacePath(file.path), `${file.path} is not an allowed workspace path`);
  }
  assert.equal(claudeAgentPath("cody"), ".claude/agents/cody.md");
});

test("replaces the managed AGENTS.md block and leaves surrounding content untouched", () => {
  const existing = `# Repo\n\nHand written guidance.\n\n${TEAM_BLOCK_START}\nold\n${TEAM_BLOCK_END}\n\n## Trailing section\n`;
  const updated = applyTeamBlock(existing, compileTeamBlock(roster([member()])));
  assert.ok(updated.startsWith("# Repo\n\nHand written guidance."));
  assert.ok(updated.endsWith("## Trailing section\n"));
  assert.ok(!updated.includes("old"));
  assert.equal(updated.indexOf(TEAM_BLOCK_START), updated.lastIndexOf(TEAM_BLOCK_START));
});

test("appends the managed block when AGENTS.md has none, and round-trips", () => {
  const block = compileTeamBlock(roster([member()]));
  const created = applyTeamBlock("", block);
  assert.equal(readTeamBlock(created), block);

  const appended = applyTeamBlock("# Repo\n\nGuidance.\n", block);
  assert.ok(appended.startsWith("# Repo\n\nGuidance."));
  assert.equal(readTeamBlock(appended), block);
  // Re-applying an identical roster must be a no-op rather than stacking blocks.
  assert.equal(applyTeamBlock(appended, block), appended);
});

// The block is repository documentation loaded by every CLI, so it describes the whole team even
// though only Claude gets native subagent files.
test("documents every enabled member in AGENTS.md but compiles only Claude targets", () => {
  const current = roster([
    member(),
    member({ id: "renee", name: "Renee", providers: ["codex"], tools: "read-only" }),
    member({ id: "hidden", name: "Hidden", enabled: false }),
  ]);
  const block = compileTeamBlock(current);
  assert.ok(block.includes("**Cody**"));
  assert.ok(block.includes("**Renee**"));
  assert.ok(!block.includes("**Hidden**"));

  assert.deepEqual(rosterMembers(current).map((item) => item.id), ["cody", "renee"]);
  assert.deepEqual(enabledMembers(current, "claude").map((item) => item.id), ["cody"]);

  const paths = compileRoster(current, "").map((file) => file.path);
  assert.deepEqual(paths, [".claude/agents/cody.md", "AGENTS.md"]);
});

test("a claude-only policy withholds Codex-targeted compilation and the reverse", () => {
  const members = [member()];
  assert.deepEqual(enabledMembers(roster(members, { provider: "claude-only" }), "codex"), []);
  assert.equal(enabledMembers(roster(members, { provider: "claude-only" }), "claude").length, 1);
  assert.deepEqual(enabledMembers(roster(members, { provider: "codex-only" }), "claude"), []);
});

test("reports an empty roster rather than emitting a misleading block", () => {
  const block = compileTeamBlock(roster([]));
  assert.ok(block.includes("No team members are currently enabled."));
  assert.equal(readTeamBlock(applyTeamBlock("", block)), block);
});

test("the seeded team compiles cleanly and keeps delegation-quality descriptions", () => {
  assert.equal(DEFAULT_TEAM.members.length, 6);
  for (const item of DEFAULT_TEAM.members) {
    assert.ok(item.description.length > 60, `${item.id} needs a description that guides delegation`);
    assert.ok(DEFAULT_BODIES[item.id].includes(item.name), `${item.id} body should name the member`);
  }
  // Cody is the member that runs most often on the most constrained task, so it must stay cheapest.
  assert.equal(DEFAULT_TEAM.members.find((item) => item.id === "cody").tier, "fast");
  assert.equal(DEFAULT_TEAM.members.find((item) => item.id === "cody").tools, "editing");
  // Only Cody may write; every other seeded member is read-only or inspection.
  const writers = DEFAULT_TEAM.members.filter((item) => item.tools === "editing").map((item) => item.id);
  assert.deepEqual(writers, ["cody"]);
});
