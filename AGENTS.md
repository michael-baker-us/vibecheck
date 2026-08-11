# VibeCheck Repository Guidance

## Scope and architecture

- This repository contains the VibeCheck VS Code extension directly at the repository root; run project commands from the repository root with `npm ...`.
- VibeCheck provides local engineering confidence for AI-assisted coding. Preserve its local-first boundary: no hosted backend, telemetry pipeline, required network connection, or agent proxying.
- Keep repository content, findings, verification output, and reports local. Codex or Claude may process repository content only for an explicit user-selected review or change-summary action.
- Keep prompt text, assistant messages, transcripts, tool arguments, tool output, and provider credentials out of persistent extension state. The optional hook bridge must retain only bounded lifecycle metadata. Delegation attribution is the single exception: the hook bridge and workspace state may record a subagent identifier when it structurally matches a roster member id, alongside session id, tool name, and timestamps. Task descriptions, prompts, and all other tool arguments remain excluded.
- Maintain the module boundaries: `domain/` holds persisted and analysis-facing types; `collectors/` reads workspace and Git facts; `analyzers/` contains deterministic risk logic; `verification/` runs trusted commands and tracks freshness; `ui/` renders VS Code surfaces. Do not make `src/ui/` import directly from `collectors/`, `config/`, or `verification/`; keep `domain/` independent of adapters, analyzers, collectors, config, UI, and verification.
- Keep analysis deterministic and pure where practical. Provider-backed semantic reviews are explicit, read-only, and must validate structured evidence before it reaches workspace state.

## Development and verification

- Use Node.js 22 or later, npm, VS Code, and Git.
- Run `npm run check` for strict TypeScript type checking.
- Run `npm run test` for the compiled Node test suite. Tests execute against `dist/`, so changes to extension behavior should include or update the corresponding `test/*.test.cjs` coverage.
- Run `npm run coverage` when changing covered core behavior; it enforces the configured coverage thresholds.
- Run `npm run security` when dependency manifests change, and run `npm run verify` before considering a change complete.
- Use `npm run package:vsix` to create the VSIX. It runs verification and writes the package under `packages/`.
- For manual extension testing, open the repository root as the VS Code workspace and launch the `Run VibeCheck Extension` configuration (`F5`); the pre-launch task starts the TypeScript and esbuild watchers.

## Repository conventions

- Treat `.vibecheck/config.yaml` and `.vibecheck/rules.yaml` as the repository's configured quality gates and architecture boundaries. Keep their commands and invalidation paths aligned with relevant source, test, resource, and manifest changes.
- Preserve the explicit trust boundary around verification commands: commands are user-configured and individually trusted, rather than inferred and run automatically.
- Preserve the native VS Code workflow: VibeCheck observes and reports repository state but does not stage, commit, or replace VS Code's source-control and diff experience.
- Preserve the reviewed Agent Workspace workflow: instruction and supporting-file generation is read-only until an explicit apply action, validates allowed paths and structured content, rejects stale proposals, and backs up replaced files outside the repository.
