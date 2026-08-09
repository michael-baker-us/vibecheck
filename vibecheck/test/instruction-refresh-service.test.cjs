const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const {
  InstructionRefreshService,
  claudeInstructionRefreshArguments,
  codexInstructionRefreshArguments,
  normalizeInstructionRefreshEvent,
  parseInstructionRefreshOutput,
} = require("../dist/agent-instructions/refresh-service");
const { buildInstructionRefreshPrompt } = require("../dist/prompts/instruction-refresh-builder");

const selection = {
  provider: "codex",
  profile: "balanced",
  model: "gpt-test",
  effort: "medium",
};

const workspaceOutput = (overrides = {}) => ({
  summary: "Updated workspace.",
  files: [
    { path: "AGENTS.md", content: "# Repository\n", rationale: "Shared repository guidance." },
    { path: "CLAUDE.md", content: "@AGENTS.md\n", rationale: "Claude imports shared guidance." },
  ],
  ...overrides,
});

test("runs instruction generation in read-only structured-output mode", () => {
  const codex = codexInstructionRefreshArguments(selection, "/tmp/schema.json", "/tmp/result.json", "audit");
  assert.ok(codex.includes("read-only"));
  assert.ok(codex.includes("--output-schema"));
  assert.equal(codex.at(-1), "audit");

  const claude = claudeInstructionRefreshArguments({ ...selection, provider: "claude" }, "audit");
  assert.ok(claude.includes("plan"));
  assert.ok(claude.includes("--json-schema"));
  assert.doesNotMatch(claude.join(" "), /Write|Edit/);
  assert.equal(claude.at(-1), "audit");
});

test("prompt establishes the supported Agent Workspace catalog and prohibits writes", () => {
  const prompt = buildInstructionRefreshPrompt();
  assert.match(prompt, /AGENTS\.md.*provider-neutral and canonical/s);
  assert.match(prompt, /CLAUDE\.md.*@AGENTS\.md/s);
  assert.match(prompt, /Do not edit, create, delete, rename/);
  assert.match(prompt, /\.codex\/agents\/<name>\.toml/);
  assert.match(prompt, /\.claude\/rules\/<name>\.md/);
  assert.match(prompt, /do not create optional files merely because they are available/i);
});

test("supporting-file generation excludes core instructions and allows no optional files", () => {
  const prompt = buildInstructionRefreshPrompt("supporting");
  assert.match(prompt, /Do not include root `AGENTS\.md` or `CLAUDE\.md`/);
  assert.deepEqual(parseInstructionRefreshOutput(JSON.stringify({
    summary: "No supporting files are justified.",
    files: [],
  }), "supporting").files, []);
  assert.throws(() => parseInstructionRefreshOutput(JSON.stringify(workspaceOutput()), "supporting"), /initialize instructions separately/);
});

test("parses direct and Claude-wrapped proposals and enforces the shared import", () => {
  const direct = parseInstructionRefreshOutput(JSON.stringify({
    summary: "Updated commands.",
    files: [
      { path: "AGENTS.md", content: "# Repository\n", rationale: "Shared guidance." },
      { path: "CLAUDE.md", content: "@AGENTS.md\n\n# Claude\n", rationale: "Claude guidance." },
    ],
  }));
  assert.equal(direct.files[0].content, "# Repository\n");

  const wrapped = parseInstructionRefreshOutput(JSON.stringify({
    structured_output: {
      summary: "No material changes.",
      files: [
        { path: "AGENTS.md", content: "# Repository", rationale: "Shared guidance." },
        { path: "CLAUDE.md", content: "@AGENTS.md", rationale: "Claude guidance." },
      ],
    },
  }));
  assert.equal(wrapped.files[1].content, "@AGENTS.md\n");
  assert.throws(() => parseInstructionRefreshOutput(JSON.stringify({
    summary: "Unsafe split guidance.",
    files: [
      { path: "AGENTS.md", content: "# Repository", rationale: "Shared guidance." },
      { path: "CLAUDE.md", content: "# Claude only", rationale: "Claude guidance." },
    ],
  })), /does not begin by importing canonical/);
});

test("accepts native provider files and rejects unsupported or unsafe paths", () => {
  const parsed = parseInstructionRefreshOutput(JSON.stringify(workspaceOutput({
    files: [
      ...workspaceOutput().files,
      { path: ".codex/agents/reviewer.toml", content: 'name = "reviewer"\ndescription = "Review changes"\ndeveloper_instructions = "Report defects"\n', rationale: "The repository has a review workflow." },
      { path: ".claude/agents/reviewer.md", content: "---\nname: reviewer\ndescription: Review changes\n---\n\nReport defects.\n", rationale: "Claude needs the same specialized role." },
      { path: ".claude/settings.json", content: "{\"permissions\": {}}", rationale: "Project settings are explicitly documented." },
    ],
  })));
  assert.equal(parsed.files.length, 5);
  assert.throws(() => parseInstructionRefreshOutput(JSON.stringify(workspaceOutput({
    files: [...workspaceOutput().files, { path: ".claude/settings.local.json", content: "{}", rationale: "Local." }],
  }))), /unsupported Agent Workspace file/);
  assert.throws(() => parseInstructionRefreshOutput(JSON.stringify(workspaceOutput({
    files: [...workspaceOutput().files, { path: ".mcp.json", content: '{"token":"literal-secret"}', rationale: "MCP." }],
  }))), /appears to embed a credential/);
  assert.throws(() => parseInstructionRefreshOutput(JSON.stringify(workspaceOutput({
    files: [...workspaceOutput().files, { path: ".claude/settings.json", content: "{invalid", rationale: "Settings." }],
  }))), /not valid JSON/);
  assert.throws(() => parseInstructionRefreshOutput(JSON.stringify(workspaceOutput({
    files: [...workspaceOutput().files, { path: ".codex/config.toml", content: "[invalid", rationale: "Settings." }],
  }))), /not valid TOML/);
});

test("requires portable skills to be identical Claude and Codex pairs", () => {
  const skill = "---\nname: repository-workflow\ndescription: Run repository checks.\n---\n\nRun the documented checks.\n";
  const paired = parseInstructionRefreshOutput(JSON.stringify(workspaceOutput({
    files: [
      ...workspaceOutput().files,
      { path: ".agents/skills/repository-workflow/SKILL.md", content: skill, rationale: "Reusable workflow." },
      { path: ".claude/skills/repository-workflow/SKILL.md", content: skill, rationale: "Portable mirror." },
    ],
  })));
  assert.equal(paired.files.length, 4);
  assert.throws(() => parseInstructionRefreshOutput(JSON.stringify(workspaceOutput({
    files: [...workspaceOutput().files, { path: ".agents/skills/repository-workflow/SKILL.md", content: skill, rationale: "Reusable workflow." }],
  }))), /must be proposed for both/);
});

test("builds a proposal without writing, then applies with backups", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-instructions-"));
  const backups = mkdtempSync(join(tmpdir(), "vibecheck-instruction-backups-"));
  context.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(backups, { recursive: true, force: true });
  });
  writeFileSync(join(root, "AGENTS.md"), "# Old instructions\n");
  writeFileSync(join(root, "CLAUDE.md"), "@AGENTS.md\n\n# Old Claude\n");
  const runner = async (_selection, _root, _prompt, _signal, onProgress, onTranscript) => {
    onProgress?.({ label: "Inspecting repository evidence" });
    onTranscript?.({ kind: "status", label: "Instruction audit started" });
    return JSON.stringify({
      summary: "Refreshed current workflows.",
      files: [
        { path: "AGENTS.md", content: "# Current instructions\n", rationale: "Current commands." },
        { path: "CLAUDE.md", content: "@AGENTS.md\n\n# Current Claude\n", rationale: "Claude import." },
        { path: ".codex/config.toml", content: "[agents]\nmax_concurrent_threads_per_session = 4\n", rationale: "Repository uses parallel review." },
      ],
    });
  };
  const service = new InstructionRefreshService(runner);
  const proposal = await service.propose(selection, root, "audit");

  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), "# Old instructions\n");
  assert.deepEqual(proposal.files.map(({ path, status }) => ({ path, status })), [
    { path: "AGENTS.md", status: "modified" },
    { path: "CLAUDE.md", status: "modified" },
    { path: ".codex/config.toml", status: "created" },
  ]);

  const result = await service.apply(root, proposal, backups);
  assert.deepEqual(result.changedFiles, ["AGENTS.md", "CLAUDE.md", ".codex/config.toml"]);
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), "# Current instructions\n");
  assert.match(readFileSync(join(root, ".codex", "config.toml"), "utf8"), /max_concurrent_threads/);
  assert.ok(result.backupDirectory && existsSync(join(result.backupDirectory, "AGENTS.md")));
  assert.equal(readFileSync(join(result.backupDirectory, "CLAUDE.md"), "utf8"), "@AGENTS.md\n\n# Old Claude\n");
});

test("rejects a stale preview before writing either file", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-instructions-stale-"));
  const backups = mkdtempSync(join(tmpdir(), "vibecheck-instruction-backups-"));
  context.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(backups, { recursive: true, force: true });
  });
  writeFileSync(join(root, "AGENTS.md"), "# Original\n");
  writeFileSync(join(root, "CLAUDE.md"), "@AGENTS.md\n");
  const service = new InstructionRefreshService(async () => JSON.stringify({
    summary: "Update.",
    files: [
      { path: "AGENTS.md", content: "# Proposed\n", rationale: "Current guidance." },
      { path: "CLAUDE.md", content: "@AGENTS.md\n\nProposed\n", rationale: "Claude guidance." },
    ],
  }));
  const proposal = await service.propose(selection, root, "audit");
  writeFileSync(join(root, "CLAUDE.md"), "@AGENTS.md\n\nManual edit\n");

  await assert.rejects(service.apply(root, proposal, backups), /CLAUDE\.md changed after the preview/);
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), "# Original\n");
});

test("maps provider activity to instruction-audit progress", () => {
  assert.deepEqual(
    normalizeInstructionRefreshEvent("codex", { type: "item.started", item: { type: "command_execution" } }),
    { label: "Inspecting repository evidence" },
  );
  assert.deepEqual(
    normalizeInstructionRefreshEvent("claude", { type: "result" }),
    { label: "Preparing Agent Workspace preview" },
  );
});
