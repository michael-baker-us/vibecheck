# Developing VibeCheck

## Prerequisites

- Node.js 22 or later
- npm
- VS Code
- Git

## Install and verify

```bash
npm install
npm run verify
```

The verification suite type-checks the extension, creates the bundled runtime, and runs integration
tests against temporary Git repositories and isolated home directories.

## Run in an Extension Development Host

1. Open `vibecheck` as the root folder in VS Code.
2. Open **Run and Debug**.
3. Select **Run VibeCheck Extension**.
4. Press `F5`.
5. In the Extension Development Host, open a Git-backed project with at least one commit.
6. Open the VibeCheck Activity Bar view.

The pre-launch task runs TypeScript in watch mode. Extension runtime output is available in the
**VibeCheck** Output channel.

## Package and install

```bash
npm run package:vsix
code --install-extension packages/vibecheck-0.6.10.vsix --force
```

Reload the target VS Code window after installing a new build.

## Architecture

```text
collectors ─┐
config ─────┼─> observation controller ─> persisted workspace state
analyzers ──┤              │                         │
verification┘              ├─> control-center webview / status / diagnostics
plan documents ────────────┤
                           ├─> prompt and report builders
local agent events ────────┘
```

- `domain/` contains persisted and analysis-facing types.
- `collectors/` reads Git and workspace facts.
- `collectors/agent-file-collector.ts` inventories documented repository agent capability entrypoints
  using explicit starter files plus pattern-based discovery for nested and plugin-owned surfaces.
- `collectors/plan-collector.ts` discovers and parses repository Markdown plans without editing them.
- `analyzers/` contains pure deterministic risk logic.
- `verification/` runs trusted commands and hashes relevant inputs.
- `reviews/` invokes replaceable Codex or Claude CLI providers in read-only mode and validates their
  structured output before it enters workspace state. Observable provider events also feed a bounded,
  memory-only terminal transcript; hidden reasoning is neither displayed nor persisted.
- `agent-instructions/refresh-service.ts` runs the same read-only provider pattern to propose a
  validated, multi-file Claude/Codex workspace. The extension owns preview, stale-proposal checks,
  backups, and the explicit apply-all write boundary.
- `adapters/` installs and ingests optional local agent hooks.
- `ui/` renders the VS Code sidebar control center, status bar, and diagnostics.

## Privacy checks

Agent bridge tests assert that prompt content is not persisted. Adapter tests use temporary home
directories and never modify actual Codex or Claude settings. Verification output is bounded and
redacts common secret assignments before persistence. Semantic review is never automatic: the user
chooses a provider for each run, and the provider may process repository content using its configured
remote service. Usage monitoring invokes Codex `/status` and Claude `/usage`, retains only normalized
utilization/reset fields in memory, and never stores provider credentials or raw output.

## Manual evaluation

During a real agent task, check:

- external edits appear accurately after debouncing;
- high-severity findings are uncommon and actionable;
- verification becomes stale only for configured inputs;
- command changes require renewed trust;
- copied prompts improve the next interaction;
- pausing and deleting state behave predictably;
- committing advances the monitored `HEAD` automatically without a separate lifecycle action;
- Source Control remains the only changed-file and diff interface;
- agent workspace files can be opened or deliberately created from the control center;
- Generate agent workspace proposes only evidence-backed catalog files, shows all changed-file diffs,
  and changes nothing before Apply all proposed files is confirmed;
- generated portable skills are identical Claude/Codex pairs, local-only files are excluded, and
  stale proposals or embedded JSON credentials are rejected;
- missing tests, coverage, or security gates are understandable without opening YAML;
- test totals, coverage percentages, and npm-audit new/fixed counts agree with command output;
- repeat coverage and security runs show movement relative to the immediately preceding run;
- generated evidence reports agree with the Control Center quality-gate summaries;
- Codex and Claude reviews return inspectable file/line evidence and become stale after relevant edits;
- review selection, live state, and Markdown output agree on the exact model and effort passed to the CLI;
- running reviews expose live, bounded activity and completed reviews render the same Markdown shape;
- editor responsiveness remains unaffected while idle.
