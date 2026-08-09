const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

test("ships a syntactically valid task-oriented Control Center", () => {
  const source = readFileSync(join(__dirname, "..", "src", "ui", "control-center.ts"), "utf8");
  const script = source.match(/<script nonce="\$\{nonce\}">([\s\S]*?)<\/script>/)?.[1];

  assert.ok(script, "expected an embedded webview script");
  assert.doesNotThrow(() => new Function(script));
  for (const view of ["Status", "Review", "Quality", "Tools"]) {
    assert.match(source, new RegExp(`'${view}'`));
  }
  assert.match(source, /Change confidence/);
  assert.match(source, /Ready for human review/);
  assert.match(source, /next-action/);
  assert.match(source, /More actions/);
  assert.match(source, /Run code review/);
  assert.match(source, /Summarize changes/);
  assert.match(source, /showView\('tools'\)/);
  assert.match(source, /pages\.tools\.append\(changeSummary\.card\)/);
  assert.match(source, /section\('Change summary','Markdown','tools:change-summary'/);
  assert.match(source, /Working tree changes vs HEAD/);
  assert.match(source, /Source branch → target branch/);
  assert.match(source, /Fetch the latest target branch from its remote/);
  assert.match(source, /Clear review/);
  assert.match(source, /vibecheck\.clearCodeReview/);
  assert.match(source, /Claude & Codex usage/);
  assert.match(source, /pages\.tools\.append\(usage\.card\)/);
  assert.match(source, /Codex \/status and Claude \/usage/);
  assert.match(source, /Refresh usage/);
  assert.match(source, /usage-track/);
  assert.match(source, /Live CLI review/);
  assert.match(source, /review-terminal/);
  assert.match(source, /transcriptPinned/);
  assert.match(source, /focus\(\{preventScroll:true\}\)/);
  assert.match(source, /vscode-reduce-motion/);
  assert.match(source, /aria-current/);
  assert.match(source, /expandedSections/);
  assert.match(source, /summary\.section-head/);
  assert.match(source, /Claude ↔ Codex compatibility/);
  assert.match(source, /Continuously align safe, portable files in this workspace/);
  assert.match(source, /Model routing/);
  assert.match(source, /Save model routes/);
  assert.match(source, /set-model-routing/);
  assert.match(source, /Generate setup\/update prompt/);
  assert.match(source, /Agent-assisted setup and updates/);

  for (const action of [
    "select-plan", "open-plan", "refresh", "refresh-provider-usage", "pause", "resume",
    "run-all", "run-review", "clear-review", "preview-review", "summarize-changes",
    "check-output-menu", "copy-prompt", "export", "config", "setup-prompt", "install-codex",
    "install-claude", "remove-adapter", "delete", "start", "manage-agent-file",
    "initialize-agent-workspace", "align-agent-instructions", "set-agent-alignment", "resolve-agent-alignment",
    "inspect-review", "inspect-finding", "accept-finding", "dismiss-finding",
    "reopen-finding", "prompt-finding", "run-check", "check-output",
  ]) {
    assert.match(source, new RegExp(`['"]${action}['"]`), `expected ${action} to remain reachable`);
  }
});
