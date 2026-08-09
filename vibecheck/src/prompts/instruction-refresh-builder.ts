export function buildInstructionRefreshPrompt(): string {
  return `# Generate the Claude and Codex agent workspace

Inspect this repository as it exists now and propose the complete, evidence-backed Claude and Codex workspace it should have. Select useful files from the supported catalog; do not create optional files merely because they are available.

## Output contract

- Return every proposed file through the provided structured response schema with its repository-relative path, complete content, and a concise evidence-based rationale.
- Always include root \`AGENTS.md\` and root \`CLAUDE.md\`, even when their proposed contents are unchanged.
- Do not edit, create, delete, rename, or format any files. This is a read-only preview; VibeCheck applies an approved proposal later.
- Keep \`AGENTS.md\` provider-neutral and canonical for shared repository guidance.
- Keep \`CLAUDE.md\` beginning with \`@AGENTS.md\`, followed only by genuinely Claude-specific guidance.

## Supported repository files

- Shared instructions: \`AGENTS.md\`, \`CLAUDE.md\`.
- Portable repository skills: matching \`.agents/skills/<name>/SKILL.md\` and \`.claude/skills/<name>/SKILL.md\` copies. When a workflow helps both providers, return both paths with identical open-standard content.
- Codex-native files: \`.codex/config.toml\`, \`.codex/hooks.json\`, \`.codex/rules/<name>.rules\`, and \`.codex/agents/<name>.toml\`.
- Claude-native files: \`.claude/settings.json\`, \`.claude/rules/<name>.md\`, \`.claude/agents/<name>.md\`, \`.claude/skills/<name>/SKILL.md\`, \`.claude/output-styles/<name>.md\`, and \`.mcp.json\`.
- Plugin manifests: \`.codex-plugin/plugin.json\` and \`.claude-plugin/plugin.json\`, but only when this repository already contains clear plugin implementation or packaging evidence.

Do not propose personal or local-only files, user-level configuration, managed policy, generated caches, secrets, credentials, deprecated Claude commands, hook scripts that do not already exist, or files outside this catalog.

## Inspect first

Read existing Agent Workspace files, repository documentation, manifests, scripts, CI workflows, source layout, tests, build and packaging configuration, and durable project conventions. Use current repository evidence rather than generic recommendations.

## Update rules

1. Preserve accurate, deliberate existing guidance, including product context, architectural boundaries, safety constraints, and collaboration preferences.
2. Correct stale commands, paths, workflows, and descriptions when repository evidence supports the change.
3. Add important current build, test, verification, packaging, accessibility, compatibility, or maintenance rules that are clearly evidenced by the repository.
4. Remove obsolete or duplicated guidance only when the repository demonstrates that it is no longer valid.
5. Do not copy provider-specific configuration schemas, secrets, personal settings, generated files, transient state, or the contents of nested instruction files into the root files.
6. Do not claim a command passes unless you ran it. Instructions may state which commands contributors should run.
7. Keep the result concise, durable, and useful over time. Avoid narrating the audit or adding speculative roadmap content.
8. Return complete raw file contents without surrounding code fences. Summarize the material proposed changes in three sentences or fewer.`;
}
