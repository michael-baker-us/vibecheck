import { VibeCheckConfiguration } from "../domain/configuration";
import { CLAUDE_TOOL_GUIDANCE } from "../providers/claude-cli";
import { PACKAGE_MANAGER_IDS } from "../config/package-managers";

export function buildConfigurationSetupPrompt(
  configuration: VibeCheckConfiguration,
  existingConfig = false,
): string {
  const existingChecks = configuration.verification.length
    ? configuration.verification.map((check) => `- ${check.name}: \`${check.command}\` (${check.category ?? "other"}, ${check.required ? "required" : "optional"})`).join("\n")
    : "- No verification checks are currently configured.";
  const existingBoundaries = configuration.boundaries.length
    ? configuration.boundaries.map((rule) => `- ${rule.name}: ${rule.from} cannot import ${rule.cannotImport.join(", ")}`).join("\n")
    : "- No architecture boundaries are currently configured.";

  const planPatterns = configuration.plans.include.map((pattern) => `- ${pattern}`).join("\n") || "- No plan patterns are configured.";

  return `# ${existingConfig ? "Audit and update" : "Set up"} VibeCheck for this repository

${existingConfig
    ? "An existing VibeCheck configuration is already in use. Audit it against the current repository and make only evidence-backed updates; do not regenerate it from scratch."
    : "Review this repository and configure VibeCheck using evidence already present in the codebase."}

## Allowed changes

- Add or update \`.vibecheck/config.yaml\`.
- Add or update \`.vibecheck/rules.yaml\` only when the repository has clear, enforceable JavaScript or TypeScript dependency boundaries.
- Use \`.vibecheck/\` as the only VibeCheck configuration directory. Do not create alternate hidden directories or configuration locations.
- Do not modify application code, package scripts, dependencies, CI, provider settings, or secrets.
- Preserve valid existing configuration unless repository evidence shows that it is stale or incorrect.
- Edit the files directly. Do not merely return a proposed YAML block in chat.

## Inspect first

Inspect build manifests, package scripts, lockfiles, test and coverage configuration, static-analysis configuration, dependency-security tooling, CI workflows, repository documentation, source layout, and existing Markdown plans. Read the existing VibeCheck files before editing them.

Current VibeCheck checks:
${existingChecks}

Current VibeCheck boundaries:
${existingBoundaries}

Current plan patterns:
${planPatterns}

Current diff expansion threshold: ${configuration.diffExpansionThreshold}

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
    format: auto # optional; pins the metrics parser
    report_path: reports/junit.xml # optional; parse this artifact instead of command output
    invalidated_by:
      - src/**
      - test/**
      - package.json

diff_expansion_threshold: 15
\`\`\`

## Metrics parsing

VibeCheck reads pass/fail counts, coverage percentages, and vulnerability counts from gate output.
Leave \`format\` unset unless detection is ambiguous; these values are supported:

- tests: \`junit\`, \`tap\`, \`jest\`, \`vitest\`, \`mocha\`
- coverage: \`lcov\`, \`cobertura\`, \`istanbul-json\`, \`istanbul-text\`, \`go-coverage\`, \`coverage-total\`
- security: \`npm-audit-json\`, \`sarif\`, \`npm-audit-text\`
- \`none\` disables parsing for a gate that reports no metrics.

Prefer a machine-readable artifact when the runner can already write one without changing package
scripts or dependencies — for example a runner invoked with a JUnit or LCOV reporter flag. Set
\`report_path\` to the repository-relative file it writes. Terminal output is parsed when
\`report_path\` is absent, which is less reliable because it carries colour codes and progress
redraws.

Optional architecture rules belong in \`.vibecheck/rules.yaml\`:

\`\`\`yaml
boundaries:
  - name: domain-isolation
    from: src/domain/**
    cannot_import:
      - src/ui/**
\`\`\`

## Recommended gates

VibeCheck treats **tests, coverage, and dependency security** as the recommended set and reports a
repository as incomplete while any of them is missing, so do not skip one without saying why.

Dependency security rarely needs a package script. In a repository with an npm lockfile,
\`npm audit --json --audit-level=high\` is available immediately and needs no dependency; configure it
as the security gate. Use the equivalent built-in audit command for whichever ecosystem the
repository uses, when one exists that requires no installation.

Coverage often does need a dependency, such as a coverage provider for the configured test runner.
When a recommended gate needs a dependency the repository does not have, do not install it and do
not add it to \`verification\`. Record it under \`recommendations\` instead:

\`\`\`yaml
recommendations:
  - category: coverage
    reason: The configured test runner has no coverage provider installed.
    packages:
      - <exact dependency name>
    manager: npm # optional; detected from the repository when omitted
    gate:
      name: coverage
      category: coverage
      required: true
      command: <command that works once the dependency is installed>
      invalidated_by:
        - src/**
\`\`\`

A recommendation is inert. VibeCheck shows it to the user, and only an explicit action installs the
dependency and promotes \`gate\` into \`verification\`. List dependencies as plain names in
\`packages\` — never an install command, and never flags. \`manager\` accepts:
${PACKAGE_MANAGER_IDS.join(", ")}.

Never leave a recommended gate unaddressed: configure it, or record a recommendation explaining
what it needs.

## Decision rules

1. Configure only commands that can already run in this repository. A command counts as available when it is a defined package script **or** a built-in command of a toolchain the repository already uses. It does not have to be a package script.
2. Do not add package scripts, install packages, add dependencies, chain commands, or use destructive commands. Read-only network calls made by an existing audit command are acceptable.
3. Prefer direct repository commands that enforce their own pass/fail policy.
4. Mark advisory checks with \`required: false\`.
5. Keep \`invalidated_by\` patterns narrow enough to avoid unnecessary reruns while covering relevant source, test, manifest, lock, and tool-configuration files.
6. Include the repository's real Markdown plan locations. Set \`plans.active\` only when one durable shared plan is clearly canonical.
7. Add boundary rules only when imports and directory ownership make the rule deterministic; do not encode guesses.
8. Keep YAML concise, parseable, and free of provider-specific instructions.
9. Preserve the existing \`diff_expansion_threshold\`. When creating a new configuration use \`15\`; change it only when repository evidence demonstrates why another value is appropriate, and explain that evidence.

${CLAUDE_TOOL_GUIDANCE}

After editing, re-read the exact files from disk to confirm their content. VibeCheck parses and validates them against this schema when the session ends and reports any error, so do not run a YAML parser, interpreter, or validation script yourself. Summarize only the fields actually changed, explain the evidence for each change, and list anything important you intentionally left unconfigured. Do not print the entire YAML unless you were unable to edit the files. Do not claim commands pass unless you actually ran them and report that separately.`;
}
