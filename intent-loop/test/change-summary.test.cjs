const assert = require("node:assert/strict");
const test = require("node:test");

const { buildChangeSummaryMarkdown } = require("../dist/reports/change-summary-markdown");
const {
  claudeSummaryArguments,
  codexSummaryArguments,
  parseChangeSummaryOutput,
} = require("../dist/summaries/change-summary-service");

const request = {
  scope: "commits",
  base: "a".repeat(40),
  target: "b".repeat(40),
  baseLabel: "main (merge base)",
  targetLabel: "HEAD",
  provider: "codex",
  profile: "balanced",
  model: "gpt-5.6-terra",
  effort: "medium",
};

test("passes an explicit revision range and model to summary providers", () => {
  const codex = codexSummaryArguments(request, "/tmp/schema.json", "/tmp/result.json");
  assert.deepEqual(codex.slice(0, 6), [
    "exec", "--model", "gpt-5.6-terra", "--config", 'model_reasoning_effort="medium"', "--sandbox",
  ]);
  assert.match(codex.at(-1), new RegExp(`${request.base}\\.\\.${request.target}`));

  const claude = claudeSummaryArguments({ ...request, provider: "claude", model: "claude-sonnet-5" });
  assert.deepEqual(claude.slice(0, 7), [
    "--print", "--model", "claude-sonnet-5", "--effort", "medium", "--output-format", "stream-json",
  ]);
  assert.match(claude.at(-1), /plain human language/);
});

test("instructs providers to include untracked working-tree changes", () => {
  const args = codexSummaryArguments({ ...request, scope: "working-tree" }, "/tmp/schema.json", "/tmp/result.json");
  assert.match(args.at(-1), /git status --short/);
  assert.match(args.at(-1), /untracked files/);
});

test("parses provider output and omits empty optional sections", () => {
  const summary = parseChangeSummaryOutput(JSON.stringify({
    title: "Faster account setup",
    overview: "New customers can complete setup with fewer interruptions.",
    highlights: [{ heading: "Simpler onboarding", description: "The setup flow now keeps progress between steps." }],
    impact: null,
    validation: "Automated checks cover the updated flow.",
  }));
  assert.equal(summary.impact, undefined);
  assert.equal(summary.highlights.length, 1);

  const markdown = buildChangeSummaryMarkdown(summary, request, request);
  assert.match(markdown, /^# Faster account setup/m);
  assert.match(markdown, /Changes from `main \(merge base\)` to `HEAD`/);
  assert.match(markdown, /Created by Codex using `gpt-5\.6-terra` \(balanced, medium effort\)/);
  assert.match(markdown, /## What changed\n\n- \*\*Simpler onboarding:\*\*/);
  assert.doesNotMatch(markdown, /## Impact/);
  assert.match(markdown, /## Validation/);
});

test("rejects summaries without usable highlights", () => {
  assert.throws(
    () => parseChangeSummaryOutput(JSON.stringify({ title: "Change", overview: "Overview", highlights: [], impact: null, validation: null })),
    /no change highlights/,
  );
});
