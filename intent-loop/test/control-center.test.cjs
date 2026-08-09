const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

test("ships a syntactically valid task-oriented Control Center", () => {
  const source = readFileSync(join(__dirname, "..", "src", "ui", "control-center.ts"), "utf8");
  const script = source.match(/<script nonce="\$\{nonce\}">([\s\S]*?)<\/script>/)?.[1];

  assert.ok(script, "expected an embedded webview script");
  assert.doesNotThrow(() => new Function(script));
  for (const view of ["Overview", "Review", "Quality", "Attention", "Workspace"]) {
    assert.match(source, new RegExp(`'${view}'`));
  }
  assert.match(source, /Release readiness/);
  assert.match(source, /next-action/);
  assert.match(source, /Run code review/);
  assert.match(source, /Live CLI review/);
  assert.match(source, /review-terminal/);
  assert.match(source, /gpt-5\.6-terra/);
  assert.match(source, /claude-opus-5/);
});
