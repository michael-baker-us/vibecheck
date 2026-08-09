const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeReviewEvent,
  normalizeReviewTranscriptEvent,
  parseCodeReviewOutput,
} = require("../dist/reviews/code-review-service");

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
