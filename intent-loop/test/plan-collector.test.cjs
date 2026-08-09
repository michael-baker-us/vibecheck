const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const { PlanCollector, parseMarkdownPlan } = require("../dist/collectors/plan-collector");

test("parses common Markdown plan structure without imposing a proprietary format", () => {
  const plan = parseMarkdownPlan(
    "plans/auth.md",
    "# Authentication refresh\n\n## Goal\nKeep sessions safe during refresh.\n\n- [x] Map the flow\n- [~] Add rotation\n- [ ] Verify expiry\n",
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(plan.title, "Authentication refresh");
  assert.equal(plan.excerpt, "Keep sessions safe during refresh.");
  assert.deepEqual(plan.tasks.map((task) => task.status), ["completed", "in-progress", "pending"]);
});

test("discovers configured repository plans and honors a local selection", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "intent-loop-plans-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plans"));
  mkdirSync(join(root, ".claude"));
  mkdirSync(join(root, "agent-plans"));
  writeFileSync(join(root, "PLAN.md"), "# Product roadmap\n");
  writeFileSync(join(root, "plans", "current.md"), "# Current task\n- [ ] Implement it\n");
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ plansDirectory: "./agent-plans" }));
  writeFileSync(join(root, "agent-plans", "claude.md"), "# Claude plan\n");
  const git = { listRepositoryFiles: async () => ["PLAN.md", "plans/current.md"] };
  const collector = new PlanCollector(git);
  const config = { include: ["PLAN.md", "plans/*.md"] };
  const plans = await collector.collect(root, config);
  assert.equal(plans.length, 3);
  assert.equal(collector.choose(plans, config, "plans/current.md").title, "Current task");
  assert.ok(plans.some((plan) => plan.path === "agent-plans/claude.md"));
});
