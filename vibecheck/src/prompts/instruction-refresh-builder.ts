export function buildInstructionRefreshPrompt(): string {
  return `# Audit and propose updates to repository agent instructions

Inspect this repository as it exists now and propose refreshed instructions for both Codex and Claude.

## Output contract

- Return the complete proposed contents of root \`AGENTS.md\` and root \`CLAUDE.md\` through the provided structured response schema.
- Do not edit, create, delete, rename, or format any files. This is a read-only preview; VibeCheck applies an approved proposal later.
- Keep \`AGENTS.md\` provider-neutral and canonical for shared repository guidance.
- Keep \`CLAUDE.md\` beginning with \`@AGENTS.md\`, followed only by genuinely Claude-specific guidance.

## Inspect first

Read the existing \`AGENTS.md\` and \`CLAUDE.md\`, repository documentation, manifests, scripts, CI workflows, source layout, tests, build and packaging configuration, and durable project conventions. Use current repository evidence rather than generic recommendations.

## Update rules

1. Preserve accurate, deliberate existing guidance, including product context, architectural boundaries, safety constraints, and collaboration preferences.
2. Correct stale commands, paths, workflows, and descriptions when repository evidence supports the change.
3. Add important current build, test, verification, packaging, accessibility, compatibility, or maintenance rules that are clearly evidenced by the repository.
4. Remove obsolete or duplicated guidance only when the repository demonstrates that it is no longer valid.
5. Do not copy provider-specific configuration schemas, secrets, personal settings, generated files, transient state, or the contents of nested instruction files into the root files.
6. Do not claim a command passes unless you ran it. Instructions may state which commands contributors should run.
7. Keep the result concise, durable, and useful over time. Avoid narrating the audit or adding speculative roadmap content.
8. Return complete Markdown file contents without surrounding code fences. Summarize the material proposed changes in three sentences or fewer.`;
}
