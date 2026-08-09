const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const { GitCollector } = require("../dist/collectors/git-collector");
const { VerificationService } = require("../dist/verification/verification-service");

test("runs trusted-style local checks and invalidates them after relevant edits", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-verification-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "--quiet");
  git("config", "user.name", "VibeCheck Test");
  git("config", "user.email", "vibecheck@example.invalid");
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
  const root = mkdtempSync(join(tmpdir(), "vibecheck-verification-summary-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "--quiet");
  git("config", "user.name", "VibeCheck Test");
  git("config", "user.email", "vibecheck@example.invalid");
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

test("parses a written report artifact instead of the command's own output", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-verification-report-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "--quiet");
  git("config", "user.name", "VibeCheck Test");
  git("config", "user.email", "vibecheck@example.invalid");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "index.js"), "module.exports = 1;\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "baseline");
  mkdirSync(join(root, "reports"));

  const service = new VerificationService(new GitCollector());
  const result = await service.run(root, {
    name: "tests",
    command: "node -e \"require('fs').writeFileSync('reports/junit.xml','<testsuites><testsuite tests=\\\"7\\\" failures=\\\"1\\\" skipped=\\\"1\\\"/></testsuites>'); console.log('spinner noise')\"",
    invalidatedBy: ["src/**"],
    category: "tests",
    required: true,
    reportPath: "reports/junit.xml",
  });

  assert.equal(result.status, "passed");
  assert.equal(result.summaryFormat, "junit");
  assert.deepEqual(result.summary, { kind: "tests", total: 7, passed: 5, failed: 1, skipped: 1 });
  assert.equal(result.reportPathMissing, undefined);
});

test("falls back to command output and flags a missing report artifact", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-verification-missing-report-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "--quiet");
  git("config", "user.name", "VibeCheck Test");
  git("config", "user.email", "vibecheck@example.invalid");
  writeFileSync(join(root, "README.md"), "baseline\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "baseline");

  const service = new VerificationService(new GitCollector());
  const result = await service.run(root, {
    name: "tests",
    command: "node -e \"console.log('      Tests  4 passed (4)')\"",
    invalidatedBy: ["README.md"],
    category: "tests",
    required: true,
    reportPath: "reports/never-written.xml",
  });

  assert.equal(result.reportPathMissing, true);
  assert.equal(result.summaryFormat, "vitest");
  assert.equal(result.summary.total, 4);
});

test("marks a passing gate whose output has no recognisable metrics", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-verification-unrecognized-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "--quiet");
  git("config", "user.name", "VibeCheck Test");
  git("config", "user.email", "vibecheck@example.invalid");
  writeFileSync(join(root, "README.md"), "baseline\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "baseline");

  const service = new VerificationService(new GitCollector());
  const result = await service.run(root, {
    name: "tests",
    command: "node -e \"console.log('all good')\"",
    invalidatedBy: ["README.md"],
    category: "tests",
    required: true,
  });

  assert.equal(result.status, "passed");
  assert.equal(result.summary, undefined);
  assert.equal(result.summaryUnrecognized, true);
});
