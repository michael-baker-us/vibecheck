export type AgentCapabilityTemplateId =
  | "instructions"
  | "skills"
  | "codex-settings"
  | "codex-rules"
  | "codex-agents"
  | "codex-hooks"
  | "codex-mcp"
  | "claude-settings"
  | "claude-rules"
  | "claude-agents"
  | "claude-hooks"
  | "claude-mcp"
  | "claude-output-styles";

type TemplateDefinition = {
  title: string;
  targets: string[];
  notes: string[];
  exampleLanguage: string;
  example: string;
};

const DEFINITIONS: Record<AgentCapabilityTemplateId, TemplateDefinition> = {
  instructions: {
    title: "Repository instructions",
    targets: ["AGENTS.md", "CLAUDE.md"],
    notes: ["Keep AGENTS.md provider-neutral and canonical.", "Begin CLAUDE.md with @AGENTS.md, then add only Claude-specific guidance."],
    exampleLanguage: "markdown",
    example: `# Repository guidance

## Architecture

<!-- Durable boundaries and important module responsibilities. -->

## Verification

<!-- Exact repository-owned commands and when to run them. -->`,
  },
  skills: {
    title: "Reusable skill or prompt",
    targets: [".agents/skills/<skill-name>/SKILL.md", ".claude/skills/<skill-name>/SKILL.md"],
    notes: ["Use a durable lowercase name.", "Keep portable skill directories identical for Codex and Claude."],
    exampleLanguage: "markdown",
    example: `---
name: <skill-name>
description: <when this workflow should and should not be used>
---

# Workflow

<!-- Focused instructions, decision points, and verification. -->`,
  },
  "codex-settings": {
    title: "Codex project settings",
    targets: [".codex/config.toml"],
    notes: ["Add only repository-scoped settings.", "Preserve unrelated existing configuration."],
    exampleLanguage: "toml",
    example: `# Add only settings justified by this repository.
# Consult the current Codex configuration reference for supported keys.`,
  },
  "codex-rules": {
    title: "Codex command rule",
    targets: [".codex/rules/<rule-name>.rules"],
    notes: ["Rules control command execution outside the sandbox.", "Include match and non-match examples before adopting a policy."],
    exampleLanguage: "python",
    example: `prefix_rule(
    pattern = ["<command>", "<subcommand>"],
    decision = "prompt",
    justification = "<why this command needs an explicit decision>",
    match = ["<matching invocation>"],
    not_match = ["<non-matching invocation>"],
)`,
  },
  "codex-agents": {
    title: "Codex subagent",
    targets: [".codex/agents/<agent-name>.toml"],
    notes: ["Give the agent one focused responsibility.", "Choose tools, sandbox mode, model, and effort from the actual task."],
    exampleLanguage: "toml",
    example: `name = "<agent_name>"
description = "<when Codex should delegate to this agent>"
sandbox_mode = "read-only"
developer_instructions = """
<focused role, constraints, evidence, and output expectations>
"""`,
  },
  "codex-hooks": {
    title: "Codex lifecycle hooks",
    targets: [".codex/hooks.json"],
    notes: ["Reference only existing, reviewed repository commands.", "Keep hook output bounded and free of credentials or transcripts."],
    exampleLanguage: "json",
    example: `{
  "<EventName>": [
    {
      "hooks": [
        { "type": "command", "command": "<existing repository command>" }
      ]
    }
  ]
}`,
  },
  "codex-mcp": {
    title: "Codex MCP configuration",
    targets: [".codex/config.toml"],
    notes: ["Use environment-variable references for credentials.", "Preserve unrelated project settings."],
    exampleLanguage: "toml",
    example: `[mcp_servers.<server_name>]
url = "<server-url>"
# bearer_token_env_var = "<ENVIRONMENT_VARIABLE>"`,
  },
  "claude-settings": {
    title: "Claude project settings",
    targets: [".claude/settings.json"],
    notes: ["Keep team-shared settings separate from local-only settings.", "Preserve unrelated existing configuration."],
    exampleLanguage: "json",
    example: `{
  "permissions": {
    "allow": [],
    "deny": []
  }
}`,
  },
  "claude-rules": {
    title: "Claude project rule",
    targets: [".claude/rules/<rule-name>.md"],
    notes: ["Keep the rule focused and avoid duplicating CLAUDE.md.", "Add path scoping only when the guidance truly applies to a subset of files."],
    exampleLanguage: "markdown",
    example: `---
paths:
  - "<relevant glob>"
---

# Rule

<!-- Focused guidance and verification for the selected paths. -->`,
  },
  "claude-agents": {
    title: "Claude subagent",
    targets: [".claude/agents/<agent-name>.md"],
    notes: ["Give the agent one focused responsibility.", "Choose tools, model, permissions, and skills from the actual task."],
    exampleLanguage: "markdown",
    example: `---
name: <agent-name>
description: <when Claude should delegate to this agent>
tools: Read, Grep, Glob
model: inherit
---

<Focused role, constraints, evidence, and output expectations.>`,
  },
  "claude-hooks": {
    title: "Claude lifecycle hooks",
    targets: [".claude/settings.json"],
    notes: ["Reference only existing, reviewed repository commands.", "Preserve unrelated project settings."],
    exampleLanguage: "json",
    example: `{
  "hooks": {
    "<EventName>": [
      {
        "matcher": "<tool or event matcher>",
        "hooks": [
          { "type": "command", "command": "<existing repository command>" }
        ]
      }
    ]
  }
}`,
  },
  "claude-mcp": {
    title: "Claude MCP configuration",
    targets: [".mcp.json"],
    notes: ["Use environment-variable expansion rather than embedded credentials.", "Project MCP servers require user approval before use."],
    exampleLanguage: "json",
    example: `{
  "mcpServers": {
    "<server-name>": {
      "type": "http",
      "url": "<server-url>"
    }
  }
}`,
  },
  "claude-output-styles": {
    title: "Claude output style",
    targets: [".claude/output-styles/<style-name>.md"],
    notes: ["Use this only for response presentation, not durable repository rules."],
    exampleLanguage: "markdown",
    example: `---
name: <style-name>
description: <when this response style is useful>
---

<!-- Tone, structure, and formatting guidance. -->`,
  },
};

export function isAgentCapabilityTemplateId(value: unknown): value is AgentCapabilityTemplateId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(DEFINITIONS, value);
}

export function buildAgentCapabilityTemplate(id: AgentCapabilityTemplateId): string {
  const definition = DEFINITIONS[id];
  return `# Agent Workspace Template: ${definition.title}

This is an editable working document. VibeCheck has not created or changed any repository files.

## Supported target paths

${definition.targets.map((target) => `- \`${target}\``).join("\n")}

## Working brief

- Goal:
- When it should apply:
- Constraints and permissions:
- Repository evidence it should use:
- How to verify it:

## Design notes

${definition.notes.map((note) => `- ${note}`).join("\n")}

## Minimal format example

\`\`\`${definition.exampleLanguage}
${definition.example}
\`\`\`

## Suggested agent handoff

Review this brief against the current repository and create or update only the supported target files. Preserve accurate existing content, use the provider's current native schema, avoid credentials and speculative configuration, and show the exact diff before applying it.
`;
}
