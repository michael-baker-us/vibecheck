const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  applyReadmeWatermark,
  claudeReadmeArguments,
  codexReadmeArguments,
  normalizeReadmeEvent,
  parseReadmeOutput,
  parseReadmeWatermark,
  ReadmeMaintenanceService,
  readmePrompt,
} = require("../dist/readme/readme-maintenance-service");

const head = "b".repeat(40);
const base = "a".repeat(40);
const request = {
  provider: "codex",
  profile: "balanced",
  model: "gpt-5.6-terra",
  effort: "medium",
  headCommit: head,
  mode: "incremental",
  baseCommit: base,
};

test("writes and parses the canonical README watermark", () => {
  const reviewedAt = "2026-08-09T14:15:16.000Z";
  const content = applyReadmeWatermark("# Project\n\nDocs.\n", { reviewedAt, commit: head });
  assert.equal(content, `# Project\n\nDocs.\n\n<!-- vibecheck-readme: reviewed-at=${reviewedAt}; commit=${head} -->\n`);
  assert.deepEqual(parseReadmeWatermark(content), { reviewedAt, commit: head });
});

test("replaces existing marker lines and rejects malformed or duplicate watermarks", () => {
  const reviewedAt = "2026-08-09T14:15:16.000Z";
  const old = `# Project\n\n<!-- vibecheck-readme: reviewed-at=2025-01-01T00:00:00.000Z; commit=${base} -->\n`;
  const updated = applyReadmeWatermark(old, { reviewedAt, commit: head });
  assert.equal((updated.match(/vibecheck-readme:/g) ?? []).length, 1);
  assert.equal(parseReadmeWatermark("<!-- vibecheck-readme: reviewed-at=yesterday; commit=" + base + " -->"), undefined);
  assert.equal(parseReadmeWatermark(`${updated}${updated}`), undefined);
  assert.equal(parseReadmeWatermark(`${updated}\nMore documentation.`), undefined);
});

test("builds incremental and whole-repository prompts from watermark scope", () => {
  assert.match(readmePrompt(request), new RegExp(`${base}\\.\\.${head}`));
  assert.match(readmePrompt(request), /current working-tree and untracked changes/);
  assert.match(readmePrompt({ ...request, mode: "full", baseCommit: undefined }), /review the whole repository/);
  assert.match(readmePrompt({ ...request, mode: "full", baseCommit: undefined }), /Create or revise a holistic README/);
});

test("passes the selected model, effort, schema, and read-only permissions to providers", () => {
  const codex = codexReadmeArguments(request, "/tmp/schema.json", "/tmp/result.json");
  assert.deepEqual(codex.slice(0, 7), [
    "exec", "--model", "gpt-5.6-terra", "--config", 'model_reasoning_effort="medium"', "--sandbox", "read-only",
  ]);
  assert.ok(codex.includes("/tmp/schema.json"));
  assert.ok(codex.includes("/tmp/result.json"));

  const claude = claudeReadmeArguments({ ...request, provider: "claude", model: "claude-sonnet-5" });
  assert.deepEqual(claude.slice(0, 7), [
    "--print", "--model", "claude-sonnet-5", "--effort", "medium", "--output-format", "stream-json",
  ]);
  assert.ok(claude.includes("plan"));
  assert.doesNotMatch(claude.join(" "), /Write|Edit/);
});

test("parses README provider output and enforces required content", () => {
  assert.deepEqual(parseReadmeOutput(JSON.stringify({ summary: "Updated setup.", content: "# Project\n\nSetup." })), {
    summary: "Updated setup.",
    content: "# Project\n\nSetup.",
  });
  assert.deepEqual(parseReadmeOutput(JSON.stringify({ structured_output: { summary: "Created docs.", content: "# Project" } })), {
    summary: "Created docs.",
    content: "# Project",
  });
  assert.throws(() => parseReadmeOutput("not json"), /invalid JSON/);
  assert.throws(() => parseReadmeOutput(JSON.stringify({ summary: "", content: "# Project" })), /empty summary/);
  assert.throws(() => parseReadmeOutput(JSON.stringify({ summary: "Summary", content: "" })), /empty README/);
});

test("normalizes README provider progress", () => {
  assert.deepEqual(normalizeReadmeEvent("codex", { type: "turn.started" }), { label: "Reviewing README scope" });
  assert.deepEqual(normalizeReadmeEvent("claude", {
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "package.json" } }] },
  }), { label: "Inspecting repository evidence" });
});

test("uses an ancestor watermark for an incremental review and writes only the validated README", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibecheck-readme-test-"));
  const reviewedAt = "2026-01-01T00:00:00.000Z";
  await writeFile(path.join(root, "README.md"), applyReadmeWatermark("# Old", { reviewedAt, commit: base }), "utf8");
  const gitCalls = [];
  const runner = async (_provider, args) => {
    const resultPath = args[args.indexOf("--output-last-message") + 1];
    await writeFile(resultPath, JSON.stringify({ summary: "Refreshed setup docs.", content: "# New\n\nCurrent setup." }), "utf8");
    return [];
  };
  const gitRunner = async (args) => {
    gitCalls.push(args);
    if (args[0] === "rev-parse") return `${head}\n`;
    if (args[0] === "merge-base") return "";
    throw new Error(`Unexpected Git command: ${args.join(" ")}`);
  };
  try {
    const result = await new ReadmeMaintenanceService(runner, gitRunner).run(request, root);
    assert.equal(result.mode, "incremental");
    assert.equal(result.baseCommit, base);
    assert.equal(result.headCommit, head);
    assert.ok(gitCalls.some((args) => args.join(" ") === `merge-base --is-ancestor ${base} ${head}`));
    const written = await readFile(path.join(root, "README.md"), "utf8");
    assert.match(written, /^# New\n\nCurrent setup\./);
    const watermark = parseReadmeWatermark(written);
    assert.ok(watermark);
    assert.equal(watermark.commit, head);
    assert.match(watermark.reviewedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
