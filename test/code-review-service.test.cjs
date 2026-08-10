const assert = require("node:assert/strict");
const test = require("node:test");

const {
  claudeReviewArguments,
  codexReviewArguments,
  normalizeReviewEvent,
  normalizeReviewTranscriptEvent,
  parseCodeReviewOutput,
  reviewPrompt,
} = require("../dist/reviews/code-review-service");

test("passes the selected model and effort explicitly to each CLI", () => {
  const codex = codexReviewArguments(
    { provider: "codex", profile: "deep", model: "gpt-5.6-sol", effort: "high" },
    "/tmp/schema.json",
    "/tmp/result.json",
  );
  assert.deepEqual(codex.slice(0, 6), [
    "exec", "--model", "gpt-5.6-sol", "--config", 'model_reasoning_effort="high"', "--sandbox",
  ]);

  const claude = claudeReviewArguments(
    { provider: "claude", profile: "balanced", model: "claude-sonnet-5", effort: "medium" },
  );
  assert.deepEqual(claude.slice(0, 7), [
    "--print", "--model", "claude-sonnet-5", "--effort", "medium", "--output-format", "stream-json",
  ]);
});

test("parses structured review findings and assigns stable ids", () => {
  const result = parseCodeReviewOutput(JSON.stringify({
    summary: "One correctness issue.",
    findings: [{
      title: "Incorrect fallback",
      explanation: "The new fallback returns stale state.",
      severity: "high",
      path: "src/state.ts",
      line: 18,
      endLine: 20,
    }],
  }));

  assert.equal(result.summary, "One correctness issue.");
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].id, /^[a-f0-9]{16}$/);
  assert.deepEqual(
    { severity: result.findings[0].severity, path: result.findings[0].path, line: result.findings[0].line },
    { severity: "high", path: "src/state.ts", line: 18 },
  );
});

test("unwraps Claude structured output and rejects unsafe evidence paths", () => {
  const result = parseCodeReviewOutput(JSON.stringify({
    structured_output: {
      summary: "Review complete.",
      findings: [{
        title: "Unscoped evidence",
        explanation: "The provider returned a path outside the repository.",
        severity: "unexpected",
        path: "../secret.txt",
        line: 0,
        endLine: null,
      }],
    },
  }));

  assert.equal(result.findings[0].severity, "info");
  assert.equal(result.findings[0].path, undefined);
  assert.equal(result.findings[0].line, undefined);
});

test("rejects malformed provider output", () => {
  assert.throws(
    () => parseCodeReviewOutput(JSON.stringify({ summary: "missing findings" })),
    /invalid structured response/,
  );
});

test("normalizes provider events without exposing raw model text", () => {
  assert.deepEqual(
    normalizeReviewEvent("codex", { type: "item.started", item: { type: "command_execution", command: "cat .env" } }),
    { label: "Inspecting repository evidence" },
  );
  assert.deepEqual(
    normalizeReviewEvent("claude", {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/repo/src/ui/panel.ts" } }] },
    }),
    { label: "Reading changed code", detail: "src/ui/panel.ts" },
  );
  assert.equal(
    normalizeReviewEvent("claude", { type: "assistant", message: { content: [{ type: "text", text: "private reasoning" }] } }),
    undefined,
  );
});

test("renders detailed Codex commands and bounded output into the live transcript", () => {
  assert.deepEqual(
    normalizeReviewTranscriptEvent("codex", {
      type: "item.started",
      item: { type: "command_execution", command: "git diff --stat" },
    }),
    [{ kind: "tool", label: "Command", content: "git diff --stat" }],
  );
  assert.deepEqual(
    normalizeReviewTranscriptEvent("codex", {
      type: "item.completed",
      item: { type: "command_execution", aggregated_output: "2 files changed", exit_code: 0 },
    }),
    [{ kind: "output", label: "Command output · exit 0", content: "2 files changed" }],
  );
});

test("renders Claude messages, tool calls, and results into the same transcript model", () => {
  assert.deepEqual(
    normalizeReviewTranscriptEvent("claude", {
      type: "assistant",
      message: { content: [
        { type: "text", text: "I’ll inspect the affected controller." },
        { type: "tool_use", name: "Read", input: { file_path: "src/controller.ts" } },
      ] },
    }),
    [
      { kind: "assistant", label: "Claude", content: "I’ll inspect the affected controller." },
      { kind: "tool", label: "Read", content: '{\n  "file_path": "src/controller.ts"\n}' },
    ],
  );
  assert.deepEqual(
    normalizeReviewTranscriptEvent("claude", {
      type: "user",
      message: { content: [{ type: "tool_result", content: "export class Controller {}" }] },
    }),
    [{ kind: "output", label: "Tool result", content: "export class Controller {}" }],
  );
});

test("distinguishes Claude initialization from repeated thinking system events", () => {
  assert.deepEqual(
    normalizeReviewTranscriptEvent("claude", {
      type: "system",
      subtype: "init",
      model: "claude-opus-5",
      permissionMode: "plan",
    }),
    [{
      kind: "status",
      label: "Claude session started",
      content: "Model: claude-opus-5 · Permissions: plan",
    }],
  );
  assert.deepEqual(
    normalizeReviewTranscriptEvent("claude", {
      type: "system",
      subtype: "thinking_tokens",
      estimated_tokens: 150,
    }),
    [],
  );
  assert.deepEqual(
    normalizeReviewEvent("claude", { type: "system", subtype: "thinking_tokens" }),
    { label: "Analyzing changes" },
  );
});

test("reviews an explicit revision range instead of the working tree", () => {
  const range = {
    scope: "commits",
    base: "abc123",
    target: "def456",
    baseLabel: "main (merge base)",
    targetLabel: "feature/x",
  };
  const scoped = reviewPrompt(range);
  assert.match(scoped, /git diff abc123\.\.def456/);
  assert.match(scoped, /git log abc123\.\.def456/);
  assert.doesNotMatch(scoped, /uncommitted working-tree/);

  const working = reviewPrompt();
  assert.match(working, /uncommitted working-tree changes against HEAD/);
  assert.doesNotMatch(working, /git diff \w+\.\./);

  // The shared review rules apply to both scopes.
  for (const prompt of [scoped, working]) {
    assert.match(prompt, /at most 10 concrete, actionable defects/);
    assert.match(prompt, /Do not modify files/);
  }
});

test("passes the range into both providers' arguments", () => {
  const selection = { provider: "claude", profile: "deep", model: "claude-opus-5", effort: "high" };
  const range = { scope: "commits", base: "aaa", target: "bbb", baseLabel: "aaa", targetLabel: "bbb" };

  const claude = claudeReviewArguments(selection, range);
  assert.match(claude.at(-1), /git diff aaa\.\.bbb/);
  assert.ok(claude.includes("dontAsk"), "a non-interactive review must not use plan mode");
  assert.match(claude.join(" "), /Bash\(git log \*\)/, "a range review needs commit history");
  assert.doesNotMatch(claude.join(" "), /Write|Edit/, "reviews stay read-only");

  const codex = codexReviewArguments({ ...selection, provider: "codex" }, "/tmp/s.json", "/tmp/r.json", range);
  assert.match(codex.at(-1), /git diff aaa\.\.bbb/);
});
