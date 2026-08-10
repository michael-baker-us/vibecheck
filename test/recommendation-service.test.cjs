const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const { ConfigLoader } = require("../dist/config/config-loader");
const { RecommendationService, installFailure } = require("../dist/config/recommendation-service");
const {
  PACKAGE_MANAGERS,
  detectPackageManager,
  isSafePackageToken,
} = require("../dist/config/package-managers");

const RECOMMENDATION = {
  id: "coverage:coverage",
  category: "coverage",
  reason: "Vitest has no coverage provider installed.",
  packages: ["@vitest/coverage-v8"],
  gate: {
    name: "coverage",
    category: "coverage",
    required: true,
    command: "npx vitest run --coverage",
    invalidatedBy: ["src/**"],
    format: "istanbul-text",
  },
};

const repoWith = (context, files) => {
  const root = mkdtempSync(join(tmpdir(), "vibecheck-recommend-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".vibecheck"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  return root;
};

test("builds an install argument vector rather than a shell string", async (context) => {
  const root = repoWith(context, { "package-lock.json": "{}", "package.json": "{}" });
  const plan = await new RecommendationService().plan(root, RECOMMENDATION);
  assert.equal(plan.manager.id, "npm");
  assert.deepEqual(plan.argv, ["npm", "install", "--save-dev", "@vitest/coverage-v8"]);
});

test("prefers a lockfile over a bare manifest when both are present", () => {
  const present = new Set(["package.json", "pnpm-lock.yaml"]);
  assert.equal(detectPackageManager((file) => present.has(file)).id, "pnpm");
});

test("supports non-JavaScript ecosystems from the same registry", () => {
  const cases = [
    ["Cargo.lock", "cargo", ["cargo", "add", "--dev", "x"]],
    ["poetry.lock", "poetry", ["poetry", "add", "--group", "dev", "x"]],
    ["go.sum", "go", ["go", "get", "x"]],
    ["Gemfile.lock", "bundler", ["bundle", "add", "--group", "development", "x"]],
  ];
  for (const [marker, id, argv] of cases) {
    const manager = detectPackageManager((file) => file === marker);
    assert.equal(manager.id, id, `${marker} should resolve to ${id}`);
    assert.deepEqual(manager.devInstall(["x"]), argv);
  }
});

test("rejects dependency tokens that could act as options or shell input", () => {
  for (const token of ["--force", "-D", "a b", "pkg; rm -rf /", "pkg && curl x", "$(whoami)", "../escape", "pkg|tee"]) {
    assert.equal(isSafePackageToken(token), false, `${token} must be rejected`);
  }
  for (const token of ["@vitest/coverage-v8", "pytest-cov", "coverage==7.4.0", "@scope/pkg@^1.2.3"]) {
    assert.equal(isSafePackageToken(token), true, `${token} must be accepted`);
  }
});

test("the loader refuses a recommendation carrying an install command instead of packages", async (context) => {
  const root = repoWith(context, {});
  const write = (body) => writeFileSync(join(root, ".vibecheck", "config.yaml"), body);
  const gate = "    gate:\n      name: coverage\n      command: npx vitest run --coverage\n      invalidated_by: [src/**]\n";

  write(`recommendations:\n  - category: coverage\n    reason: needs a provider\n    packages: ["npm install --save-dev evil"]\n${gate}`);
  await assert.rejects(new ConfigLoader().load(root), /not a plain package name/);

  write(`recommendations:\n  - category: coverage\n    reason: needs a provider\n    packages: ["--registry=http://evil"]\n${gate}`);
  await assert.rejects(new ConfigLoader().load(root), /not a plain package name/);

  write(`recommendations:\n  - category: coverage\n    reason: needs a provider\n    packages: [pkg]\n    manager: curl\n${gate}`);
  await assert.rejects(new ConfigLoader().load(root), /manager must be one of/);

  write(`recommendations:\n  - category: coverage\n    reason: needs a provider\n    packages: []\n${gate}`);
  await assert.rejects(new ConfigLoader().load(root), /at least one dependency/);
});

test("loads a valid recommendation and gives it a stable id", async (context) => {
  const root = repoWith(context, {});
  writeFileSync(
    join(root, ".vibecheck", "config.yaml"),
    [
      "recommendations:",
      "  - category: coverage",
      "    reason: The test runner has no coverage provider.",
      "    packages:",
      "      - \"@vitest/coverage-v8\"",
      "    gate:",
      "      name: coverage",
      "      required: true",
      "      command: npx vitest run --coverage",
      "      format: istanbul-text",
      "      invalidated_by: [src/**]",
      "",
    ].join("\n"),
  );
  const { recommendations } = await new ConfigLoader().load(root);
  assert.equal(recommendations.length, 1);
  assert.equal(recommendations[0].id, "coverage:coverage");
  assert.equal(recommendations[0].gate.category, "coverage", "the gate inherits the recommendation category");
  assert.equal(recommendations[0].gate.format, "istanbul-text");
});

test("promotes the gate into verification and drops the recommendation after a successful install", async (context) => {
  const root = repoWith(context, { "package-lock.json": "{}" });
  writeFileSync(
    join(root, ".vibecheck", "config.yaml"),
    [
      "# Quality gates for this repository",
      "verification:",
      "  - name: tests",
      "    category: tests",
      "    required: true",
      "    command: npm test",
      "    invalidated_by:",
      "      - src/**",
      "",
      "recommendations:",
      "  - category: coverage",
      "    reason: needs a provider",
      "    packages: [\"@vitest/coverage-v8\"]",
      "    gate:",
      "      name: coverage",
      "      required: true",
      "      command: npx vitest run --coverage",
      "      invalidated_by: [src/**]",
      "",
      "diff_expansion_threshold: 15",
      "",
    ].join("\n"),
  );

  const calls = [];
  const service = new RecommendationService(async (argv) => {
    calls.push(argv);
    return { exitCode: 0, output: "added 1 package" };
  });
  const outcome = await service.apply(root, RECOMMENDATION);

  assert.deepEqual(calls, [["npm", "install", "--save-dev", "@vitest/coverage-v8"]]);
  assert.equal(outcome.gateName, "coverage");

  const written = readFileSync(join(root, ".vibecheck", "config.yaml"), "utf8");
  assert.match(written, /# Quality gates for this repository/, "user comments must survive the edit");
  assert.doesNotMatch(written, /^recommendations:/m, "the applied recommendation is removed");

  const { verification, recommendations } = await new ConfigLoader().load(root);
  assert.equal(recommendations.length, 0);
  assert.deepEqual(verification.map((gate) => gate.name), ["tests", "coverage"]);
  const coverage = verification[1];
  assert.equal(coverage.command, "npx vitest run --coverage");
  assert.equal(coverage.format, "istanbul-text");
});

test("leaves configuration untouched when the install fails", async (context) => {
  const root = repoWith(context, { "package-lock.json": "{}" });
  const original = "verification: []\n";
  writeFileSync(join(root, ".vibecheck", "config.yaml"), original);

  const service = new RecommendationService(async () => ({ exitCode: 1, output: "E404 not found" }));
  await assert.rejects(service.apply(root, RECOMMENDATION), /could not install/);
  assert.equal(readFileSync(join(root, ".vibecheck", "config.yaml"), "utf8"), original);
});

test("every registered manager installs without a shell and declares markers", () => {
  for (const manager of PACKAGE_MANAGERS) {
    const argv = manager.devInstall(["pkg-a", "pkg-b"]);
    assert.ok(argv.length >= 3, `${manager.id} needs a full argument vector`);
    assert.ok(manager.markers.length, `${manager.id} needs marker files`);
    assert.deepEqual(argv.slice(-2), ["pkg-a", "pkg-b"], `${manager.id} must put packages last`);
    assert.ok(!argv.some((part) => /[;|&$`]/.test(part)), `${manager.id} must not build shell syntax`);
  }
});

test("reports why an install failed rather than where the log lives", () => {
  const npmEresolve = [
    "npm error code ERESOLVE",
    "npm error ERESOLVE unable to resolve dependency tree",
    "npm error",
    "npm error While resolving: motherload@0.1.0",
    "npm error Found: vitest@3.2.7",
    "npm error Could not resolve dependency:",
    "npm error peer vitest@\"4.1.10\" from @vitest/coverage-v8@4.1.10",
    "npm error A complete log of this run can be found in: /Users/x/.npm/_logs/2026-debug-0.log",
  ].join("\n");

  const message = installFailure(npmEresolve);
  assert.match(message, /unable to resolve dependency tree/);
  assert.match(message, /peer-dependency conflict/);
  assert.doesNotMatch(message, /_logs/, "the log path is not an explanation");
  assert.doesNotMatch(message, /A complete log/);
});

test("falls back to the output itself when nothing looks like an error line", () => {
  assert.match(installFailure("something went sideways"), /something went sideways/);
  assert.equal(installFailure(""), "");
});

test("surfaces a registry 404 without the surrounding noise", () => {
  const output = [
    "npm error code E404",
    "npm error 404 Not Found - GET https://registry.npmjs.org/@scope%2fmissing",
    "npm error A complete log of this run can be found in: /Users/x/.npm/_logs/x.log",
  ].join("\n");
  const message = installFailure(output);
  assert.match(message, /E404|404 Not Found/);
  assert.doesNotMatch(message, /_logs/);
});

test("accepts a version-pinned dependency so peer resolution can succeed", () => {
  assert.equal(isSafePackageToken("@vitest/coverage-v8@^3.2.0"), true);
  const manager = PACKAGE_MANAGERS.find((entry) => entry.id === "npm");
  assert.deepEqual(
    manager.devInstall(["@vitest/coverage-v8@^3.2.0"]),
    ["npm", "install", "--save-dev", "@vitest/coverage-v8@^3.2.0"],
  );
});
