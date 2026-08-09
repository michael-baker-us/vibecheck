const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const { GitCollector } = require("../dist/collectors/git-collector");

test("discovers a repository and captures content-aware changes", async (context) => {
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
  assert.equal(repository.branch, git("branch", "--show-current").trim());
  assert.equal(repository.subject, "baseline");
  assert.equal(await collector.resolveCommit(repository.root, "HEAD"), repository.head);
  assert.equal(await collector.mergeBase(repository.root, repository.head, "HEAD"), repository.head);
  assert.equal(await collector.hasChangesBetween(repository.root, repository.head, "HEAD"), false);
  await assert.rejects(() => collector.resolveCommit(repository.root, "missing-ref"), /Git revision not found/);
  assert.deepEqual(await collector.collectChanges(repository.root, repository.head), []);
  assert.equal(await collector.isWorkingTreeClean(repository.root), true);

  writeFileSync(join(repositoryRoot, "tracked.txt"), "changed\n");
  writeFileSync(join(repositoryRoot, "untracked file.txt"), "new\n");

  assert.deepEqual(await collector.collectChanges(repository.root, repository.head), [
    {
      path: "tracked.txt",
      status: "modified",
      binary: false,
      before: "baseline\n",
      after: "changed\n",
    },
    {
      path: "untracked file.txt",
      status: "added",
      binary: false,
      before: undefined,
      after: "new\n",
    },
  ]);
  assert.equal(await collector.isWorkingTreeClean(repository.root), false);
  assert.match(await collector.getDiff(repository.root, repository.head, "untracked file.txt"), /\+new/);
});
