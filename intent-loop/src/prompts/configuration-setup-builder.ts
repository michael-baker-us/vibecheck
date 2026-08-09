import { IntentLoopConfiguration } from "../domain/configuration";

export function buildConfigurationSetupPrompt(configuration: IntentLoopConfiguration): string {
  const existingChecks = configuration.verification.length
    ? configuration.verification.map((check) => `- ${check.name}: \`${check.command}\` (${check.category ?? "other"}, ${check.required ? "required" : "optional"})`).join("\n")
    : "- No verification checks are currently configured.";
  const existingBoundaries = configuration.boundaries.length
    ? configuration.boundaries.map((rule) => `- ${rule.name}: ${rule.from} cannot import ${rule.cannotImport.join(", ")}`).join("\n")
    : "- No architecture boundaries are currently configured.";

  return `# Configure VibeCheck for this repository

Review this repository and configure VibeCheck using evidence already present in the codebase.

## Allowed changes

- Add or update \`.intent-loop/config.yaml\`.
- Add or update \`.intent-loop/rules.yaml\` only when the repository has clear, enforceable JavaScript or TypeScript dependency boundaries.
- Do not modify application code, package scripts, dependencies, CI, provider settings, or secrets.
- Preserve valid existing configuration unless repository evidence shows that it is stale or incorrect.

## Inspect first

Inspect build manifests, package scripts, lockfiles, test and coverage configuration, static-analysis configuration, dependency-security tooling, CI workflows, repository documentation, source layout, and existing Markdown plans. Read the existing VibeCheck files before editing them.

Current VibeCheck checks:
${existingChecks}

Current VibeCheck boundaries:
${existingBoundaries}

## Configuration contract

Use only this supported schema:

\`\`\`yaml
plans:
  include:
    - PLAN.md
    - plans/**/*.md
  # active: plans/current.md

verification:
  - name: tests
    category: tests # tests | coverage | security | quality | build | other
    required: true
    command: npm test
    invalidated_by:
      - src/**
      - test/**
      - package.json

diff_expansion_threshold: 15
\`\`\`

Optional architecture rules belong in \`.intent-loop/rules.yaml\`:

\`\`\`yaml
boundaries:
  - name: domain-isolation
    from: src/domain/**
    cannot_import:
      - src/ui/**
\`\`\`

## Decision rules

1. Configure only commands that already exist and are appropriate to run from the repository root.
2. Do not invent scripts, install packages, chain commands, or use destructive/network-mutating commands.
3. Prefer direct repository commands that enforce their own pass/fail policy.
4. Include tests, coverage, security, quality, and build gates only when supported by repository evidence. Mark advisory checks with \`required: false\`.
5. Keep \`invalidated_by\` patterns narrow enough to avoid unnecessary reruns while covering relevant source, test, manifest, lock, and tool-configuration files.
6. Include the repository's real Markdown plan locations. Set \`plans.active\` only when one durable shared plan is clearly canonical.
7. Add boundary rules only when imports and directory ownership make the rule deterministic; do not encode guesses.
8. Keep YAML concise, parseable, and free of provider-specific instructions.

After editing, parse the YAML, explain the evidence behind each configured gate or boundary, and list anything important you intentionally left unconfigured. Do not claim commands pass unless you actually ran them and report that separately.`;
}
