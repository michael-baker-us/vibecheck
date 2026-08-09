# Companion Repository Guidance

## Scope

The active product is the VS Code extension in `vibecheck/` (VibeCheck). Treat this repository as
a long-lived developer-tool project: preserve behavior, keep provider integrations local-first, and
prefer maintainable boundaries over one-off UI logic.

Run extension commands from `vibecheck/`; root-level agent guidance, shared skills, and
`.vibecheck/` configuration remain repository-level concerns. Development requires Node.js 22 or
later, npm, VS Code, and Git.

## Architecture and product boundaries

- Keep domain types, collectors, analyzers, verification, provider review services, and UI concerns
  separated. Put deterministic, independently testable logic outside the webview; keep analyzers
  pure where practical.
- Respect configured architecture boundaries in `.vibecheck/rules.yaml`, especially that UI code
  does not read repository, configuration, or verification state directly and `domain/` remains
  independent of implementation layers.
- Preserve VibeCheck's local-only product boundary: no hosted backend, telemetry, required network
  access, automatic semantic review, or untrusted command execution. Provider CLIs are optional,
  user-selected integrations and must retain their explicit, read-only workflow.
- Preserve user files, provider configuration, and local observation data. Do not persist secrets,
  prompts, hidden reasoning, or raw credentials; retain existing output-redaction and bounded-data
  behavior.
- VibeCheck must not stage, commit, proxy an agent, or replace VS Code's source-control and diff
  workflows.

## Build, test, and packaging

- Use `npm run check` for TypeScript validation.
- Use `npm test` for the test suite; it recompiles and bundles the extension before running Node's
  test runner.
- Use `npm run coverage` to enforce the configured coverage thresholds, and `npm run security` for
  the npm audit gate. `npm run verify` runs type checking and coverage; it does not include the
  security command.
- Run `npm run verify` before substantial handoff, packaging, or release work. Package only through
  `npm run package:vsix`, which verifies first and writes a versioned VSIX under `packages/`.
- Treat `dist/`, `coverage/`, and generated VSIX files as build artifacts: rebuild them rather than
  editing them by hand.
- Add or update focused tests with behavior changes. When controls or interactions move in the
  Control Center, keep them keyboard-accessible and update the source-level UI tests.

## Working agreement

- Update `vibecheck/README.md` and `vibecheck/DEVELOPMENT.md` when user-facing commands,
  installation or packaging steps, settings, compatibility behavior, or developer workflows change.
- Preserve unrelated work and existing extension behavior. Review the relevant implementation,
  tests, configuration, and current Git changes before editing.
- Preserve user files and provider configuration. Back up a file before an explicit replacement and
  never silently translate incompatible Claude and Codex schemas.
- Keep shared guidance provider-neutral. Put provider-only behavior in that provider's own files.

## Claude and Codex compatibility

- `AGENTS.md` is the canonical shared repository guidance; `CLAUDE.md` imports it.
- Portable repository skills are mirrored between `.agents/skills/` and `.claude/skills/`.
- The active VibeCheck Markdown plan is shared context.
- Agents, MCP, hooks, permissions, and settings remain provider-specific unless a conversion is
  known to be lossless. Surface drift for review instead of overwriting either side.
