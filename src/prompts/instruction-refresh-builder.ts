import type { InstructionRefreshScope } from "../domain/instruction-refresh";

export function buildInstructionRefreshPrompt(scope: InstructionRefreshScope = "instructions"): string {
  const supportingOnly = scope === "supporting";
  const catalog = supportingOnly
    ? `- Portable repository skills: matching \`.agents/skills/<name>/\` and \`.claude/skills/<name>/\` directories. Return identical \`SKILL.md\` files and identical text-based \`scripts/\`, \`references/\`, \`assets/\`, or \`agents/\` support files when the workflow genuinely needs them.
- Codex-native files: \`.codex/config.toml\`, \`.codex/hooks.json\`, \`.codex/rules/<name>.rules\`, and \`.codex/agents/<name>.toml\`.
- Claude-native files: \`.claude/settings.json\`, \`.claude/rules/<name>.md\`, \`.claude/agents/<name>.md\`, \`.claude/skills/<name>/SKILL.md\`, \`.claude/output-styles/<name>.md\`, and \`.mcp.json\`.`
    : `- Shared canonical guidance: \`AGENTS.md\`.
- Claude's shared-guidance bridge: \`CLAUDE.md\`, beginning with \`@AGENTS.md\` and followed only by justified Claude-specific guidance.`;
  const updateRules = supportingOnly
    ? `1. Propose a capability only when current repository evidence shows a durable benefit; an empty proposal is valid.
2. Preserve accurate existing provider configuration and change it only when evidence shows it is stale or incomplete.
3. Do not duplicate general repository guidance in rules, agents, or skills; each supporting file needs a focused purpose.
4. Use each provider's native schema without forcing lossy parity between provider-specific files.
5. Keep portable skill directories identical across Claude and Codex, including every proposed support file.
6. Do not claim a command passes unless you ran it.
7. Keep the result concise, durable, and useful over time. Avoid speculative capabilities.
8. Return complete raw file contents without surrounding code fences. Summarize the proposal in three sentences or fewer.`
    : `1. Preserve accurate, deliberate existing guidance, including product context, architectural boundaries, safety constraints, and collaboration preferences.
2. Correct stale commands, paths, workflows, and descriptions when repository evidence supports the change.
3. Add important current build, test, verification, packaging, accessibility, compatibility, or maintenance rules that are clearly evidenced by the repository.
4. Remove obsolete or duplicated guidance only when the repository demonstrates that it is no longer valid.
5. Do not copy provider-specific configuration schemas, secrets, personal settings, generated files, transient state, or the contents of nested instruction files into the root files.
6. Do not claim a command passes unless you ran it. Instructions may state which commands contributors should run.
7. Keep the result concise, durable, and useful over time. Avoid narrating the audit or adding speculative roadmap content.
8. Return complete raw file contents without surrounding code fences. Summarize the material proposed changes in three sentences or fewer.`;
  return `# Generate ${supportingOnly ? "supporting Claude and Codex workspace files" : "Claude and Codex instruction files"}

Inspect this repository as it exists now and propose ${supportingOnly ? "only the evidence-backed supporting Claude and Codex workspace files from the catalog below" : "the two evidence-backed root instruction files"}. Let repository evidence determine the content${supportingOnly ? ", file types, and names" : ""}. Do not start from generic templates. Do not create optional files merely because they are supported.

## Output contract

- Return every proposed file through the provided structured response schema with its repository-relative path, complete content, and a concise evidence-based rationale.
${supportingOnly ? "- Do not include root `AGENTS.md` or `CLAUDE.md`; VibeCheck generates those through a separate reviewed action. Return an empty files array when no supporting file is justified." : "- Return exactly two files: root `AGENTS.md` and root `CLAUDE.md`."}
- Do not edit, create, delete, rename, or format any files. This is a read-only preview; VibeCheck applies an approved proposal later.
${supportingOnly ? "" : "- Keep `AGENTS.md` provider-neutral and canonical for shared repository guidance.\n- Keep `CLAUDE.md` beginning with `@AGENTS.md`, followed only by genuinely Claude-specific guidance."}

## Supported repository files

${catalog}

Do not propose personal or local-only files, user-level configuration, managed policy, generated caches, secrets, credentials, legacy Claude command files, plugin packaging, hook scripts that do not already exist, or files outside this catalog.

## Inspect first

Read existing Agent Workspace files, repository documentation, manifests, scripts, CI workflows, source layout, tests, build and packaging configuration, and durable project conventions. Use current repository evidence rather than generic recommendations.

## Update rules

${updateRules}`;
}
