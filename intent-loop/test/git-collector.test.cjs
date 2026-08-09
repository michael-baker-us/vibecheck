const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const { GitCollector } = require("../dist/collectors/git-collector");

test("discovers a repository and reports changes relative to the baseline", async (context) => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "intent-loop-git-"));
  context.after(() => rmSync(repositoryRoot, { recursive: true, force: true }));

  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  git("init", "--quiet");
  git("config", "user.name", "Intent Loop Test");
  git("config", "user.email", "intent-loop@example.invalid");
  writeFileSync(join(repositoryRoot, "tracked.txt"), "baseline\n");
  git("add", "tracked.txt");
  git("commit", "--quiet", "-m", "baseline");

  const collector = new GitCollector();
  const repository = await collector.discover(repositoryRoot);
  assert.equal(repository.root, realpathSync(repositoryRoot));
  assert.match(repository.head, /^[0-9a-f]{40}$/);
  assert.deepEqual(await collector.listChangedPaths(repository.root, repository.head), []);

  writeFileSync(join(repositoryRoot, "tracked.txt"), "changed\n");
  writeFileSync(join(repositoryRoot, "untracked file.txt"), "new\n");

  assert.deepEqual(await collector.listChangedPaths(repository.root, repository.head), [
    "tracked.txt",
    "untracked file.txt",
  ]);
});
