const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CLAUDE_EDITING_TOOLS,
  CLAUDE_INSPECTION_TOOLS,
  CLAUDE_TOOL_GUIDANCE,
  NO_AGENT_GRANTS,
  claudeTools,
} = require("../dist/providers/claude-cli");
const { claudeConfigurationSetupArguments } = require("../dist/config/configuration-setup-service");
const { claudeInstructionRefreshArguments } = require("../dist/agent-instructions/refresh-service");
const { buildConfigurationSetupPrompt } = require("../dist/prompts/configuration-setup-builder");

const selection = { provider: "claude", profile: "balanced", model: "claude-sonnet-5", effort: "medium" };
const argumentValue = (args, flag) => args[args.indexOf(flag) + 1];

test("allows the inspection commands the setup prompt actually asks an agent to run", () => {
  // Every one of these was denied in a real session, which stalled the run.
  for (const pattern of ["Bash(cat *)", "Bash(ls *)", "Bash(find *)", "Bash(grep *)", "Bash(npm audit *)", "Bash(npm test)"]) {
    assert.ok(CLAUDE_EDITING_TOOLS.includes(pattern), `${pattern} must be permitted`);
  }
  assert.ok(CLAUDE_EDITING_TOOLS.includes("Write"));
  assert.ok(CLAUDE_EDITING_TOOLS.includes("Edit"));
});

test("keeps read-only workflows free of write tools", () => {
  const tools = CLAUDE_INSPECTION_TOOLS.split(",");
  assert.ok(!tools.includes("Write"), "an inspection session must not be able to write files");
  assert.ok(!tools.includes("Edit"));
});

test("wraps granted shell commands and passes tool names through untouched", () => {
  const tools = claudeTools("Read,Grep", { commands: ["pytest *", "WebSearch"], verificationCommands: ["npm test"] });
  assert.deepEqual(tools.split(","), ["Read", "Grep", "Bash(pytest *)", "WebSearch", "Bash(npm test)"]);
});

test("drops blank grants and never repeats an entry already in the base list", () => {
  const tools = claudeTools("Read,Bash(npm test)", { commands: ["  ", ""], verificationCommands: ["npm test"] });
  assert.deepEqual(tools.split(","), ["Read", "Bash(npm test)"]);
});

test("grants configured verification commands to a configuration session", () => {
  const args = claudeConfigurationSetupArguments(selection, "prompt", {
    commands: [],
    verificationCommands: ["npm test", "npm run build"],
  });
  const tools = argumentValue(args, "--allowed-tools");
  assert.ok(tools.includes("Bash(npm test)"));
  assert.ok(tools.includes("Bash(npm run build)"));
});

test("configuration sessions accept edits and workspace sessions never enter plan mode", () => {
  assert.equal(argumentValue(claudeConfigurationSetupArguments(selection, "prompt"), "--permission-mode"), "acceptEdits");
  // plan mode pushes a non-interactive run toward ExitPlanMode, which is not an allowed tool.
  assert.equal(argumentValue(claudeInstructionRefreshArguments(selection, "prompt"), "--permission-mode"), "dontAsk");
});

test("defaults to no grants when none are supplied", () => {
  const withDefault = claudeConfigurationSetupArguments(selection, "prompt");
  const withEmpty = claudeConfigurationSetupArguments(selection, "prompt", NO_AGENT_GRANTS);
  assert.deepEqual(withDefault, withEmpty);
});

test("the setup prompt stops asking for a YAML parser the agent cannot run", () => {
  const prompt = buildConfigurationSetupPrompt({
    verification: [],
    boundaries: [],
    diffExpansionThreshold: 15,
    plans: { include: ["PLAN.md"] },
  });

  assert.doesNotMatch(prompt, /parse them with an available YAML parser/);
  assert.match(prompt, /VibeCheck parses and validates them/);
  assert.match(prompt, /do not run a YAML parser, interpreter, or validation script yourself/);
});

test("the setup prompt warns about compound commands and interpreters", () => {
  const prompt = buildConfigurationSetupPrompt({
    verification: [],
    boundaries: [],
    diffExpansionThreshold: 15,
    plans: { include: ["PLAN.md"] },
  });
  assert.ok(prompt.includes(CLAUDE_TOOL_GUIDANCE));
  assert.match(prompt, /one command per tool call/);
  assert.match(prompt, /node -e/);
  assert.match(prompt, /python3 -c/);
});
