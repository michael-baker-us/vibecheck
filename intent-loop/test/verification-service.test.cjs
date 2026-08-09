const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const { GitCollector } = require("../dist/collectors/git-collector");
const { VerificationService } = require("../dist/verification/verification-service");

test("runs trusted-style local checks and invalidates them after relevant edits", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "intent-loop-verification-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "--quiet");
  git("config", "user.name", "Intent Loop Test");
  git("config", "user.email", "intent-loop@example.invalid");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "index.js"), "module.exports = 1;\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "baseline");

  const service = new VerificationService(new GitCollector());
  const definition = {
    name: "check",
    command: "node -e \"console.log('token=secret-value')\"",
    invalidatedBy: ["src/**"],
  };
  const result = await service.run(root, definition);
  assert.equal(result.status, "passed");
  assert.match(result.output, /token=\[REDACTED\]/);

  writeFileSync(join(root, "src", "index.js"), "module.exports = 2;\n");
  const [stale] = await service.refreshFreshness(root, [result]);
  assert.equal(stale.status, "stale");
});

test("retains structured metrics from verification output", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "intent-loop-verification-summary-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "--quiet");
  git("config", "user.name", "Intent Loop Test");
  git("config", "user.email", "intent-loop@example.invalid");
  writeFileSync(join(root, "index.js"), "module.exports = 1;\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "baseline");

  const service = new VerificationService(new GitCollector());
  const result = await service.run(root, {
    name: "tests",
    category: "tests",
    required: true,
    command: "node -e \"console.log('# tests 3\\n# pass 3\\n# fail 0')\"",
    invalidatedBy: ["**/*"],
  });
  assert.deepEqual(result.summary, {
    kind: "tests",
    total: 3,
    passed: 3,
    failed: 0,
    skipped: 0,
  });
});
