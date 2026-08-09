const assert = require("node:assert/strict");
const test = require("node:test");

const { DEFAULT_MODEL_ROUTING, normalizeModelRouting } = require("../dist/providers/model-routing");

test("normalizes configurable Balanced and Deep provider model routes", () => {
  assert.deepEqual(normalizeModelRouting({
    codexBalanced: "  custom-codex-fast  ",
    claudeDeep: "custom-claude-deep",
    codexDeep: "bad\nmodel",
  }), {
    codexBalanced: "custom-codex-fast",
    codexDeep: DEFAULT_MODEL_ROUTING.codexDeep,
    claudeBalanced: DEFAULT_MODEL_ROUTING.claudeBalanced,
    claudeDeep: "custom-claude-deep",
  });
});
