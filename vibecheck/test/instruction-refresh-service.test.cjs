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

test("prompt establishes AGENTS.md as canonical and prohibits writes", () => {
  const prompt = buildInstructionRefreshPrompt();
  assert.match(prompt, /AGENTS\.md.*provider-neutral and canonical/s);
  assert.match(prompt, /CLAUDE\.md.*@AGENTS\.md/s);
  assert.match(prompt, /Do not edit, create, delete, rename/);
});

test("parses direct and Claude-wrapped proposals and enforces the shared import", () => {
  const direct = parseInstructionRefreshOutput(JSON.stringify({
    summary: "Updated commands.",
    agentsMarkdown: "# Repository\n",
    claudeMarkdown: "@AGENTS.md\n\n# Claude\n",
  }));
  assert.equal(direct.agentsMarkdown, "# Repository\n");

  const wrapped = parseInstructionRefreshOutput(JSON.stringify({
    structured_output: {
      summary: "No material changes.",
      agentsMarkdown: "# Repository",
      claudeMarkdown: "@AGENTS.md",
    },
  }));
  assert.equal(wrapped.claudeMarkdown, "@AGENTS.md\n");
  assert.throws(() => parseInstructionRefreshOutput(JSON.stringify({
    summary: "Unsafe split guidance.",
    agentsMarkdown: "# Repository",
    claudeMarkdown: "# Claude only",
  })), /does not begin by importing canonical/);
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
      agentsMarkdown: "# Current instructions\n",
      claudeMarkdown: "@AGENTS.md\n\n# Current Claude\n",
    });
  };
  const service = new InstructionRefreshService(runner);
  const proposal = await service.propose(selection, root, "audit");

  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), "# Old instructions\n");
  assert.deepEqual(proposal.files.map(({ path, status }) => ({ path, status })), [
    { path: "AGENTS.md", status: "modified" },
    { path: "CLAUDE.md", status: "modified" },
  ]);

  const result = await service.apply(root, proposal, backups);
  assert.deepEqual(result.changedFiles, ["AGENTS.md", "CLAUDE.md"]);
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), "# Current instructions\n");
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
    agentsMarkdown: "# Proposed\n",
    claudeMarkdown: "@AGENTS.md\n\nProposed\n",
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
    { label: "Preparing instruction preview" },
  );
});
