# VibeCheck

**Local engineering confidence for AI-assisted coding in VS Code.**

VibeCheck observes repository changes, verification results, and optional Codex or Claude lifecycle
events on your machine. It surfaces risky changes and stale evidence, then helps you decide what to
inspect or ask the agent next.

You continue using Codex or Claude normally. VibeCheck does not proxy, replace, or remotely
monitor the agent.

## What it does

- Monitors uncommitted work relative to the current `HEAD` and advances automatically after commits.
- Detects runtime dependency changes, weakened tests, sensitive files, binaries, generated files,
  broad diffs, and configured TypeScript/JavaScript architecture boundaries.
- Runs only explicitly configured and individually trusted local verification commands.
- Presents tests, coverage, security, and other checks as visible quality gates.
- Extracts test pass/fail/skip totals, coverage percentages and movement, and new/fixed dependency
  vulnerabilities from supported command output.
- Marks passing verification stale when its relevant input files change.
- Discovers and follows existing repository Markdown plans instead of maintaining duplicate intent.
- Maintains an attention queue with fact, configured-rule, and heuristic provenance.
- Generates concrete follow-up prompts for the existing agent interface.
- Creates local Markdown evidence reports without writing into the source tree unless you save them.
- Inventories documented repository-scoped Codex and Claude capabilities—guidance, skills,
  reusable prompts, subagents, settings, rules, hooks, MCP, plugins, and output styles—and opens or
  creates safe starter files from one workspace.
- Optionally ingests normalized local Codex and Claude hook events.
- Runs explicit, read-only semantic reviews through an installed Codex or Claude CLI, records
  structured findings with file/line evidence, and marks results stale when the diff changes.
- Makes model routing explicit before every review: Balanced uses `gpt-5.6-terra` or
  `claude-sonnet-5` at medium effort; Deep uses `gpt-5.6-sol` or `claude-opus-5` at high effort.
- Streams a terminal-style, memory-only transcript into the Review view while the CLI is running,
  including assistant messages, tool calls, commands, and bounded tool output. Completed Codex and
  Claude results use the same concise Markdown report format.

## Local-only boundary

VibeCheck has no account, hosted backend, product telemetry, external LLM, or required network
connection. Repository contents, findings, command output, agent metadata, and reports stay on the
machine.

VibeCheck invokes Codex or Claude only when you select **Run code review** and choose a provider.
That provider may send repository content to its configured service under its own authentication
and data controls. VibeCheck stores only the structured review result in VS Code workspace state.

The optional hook bridge deliberately excludes prompt text, assistant messages, transcripts, tool
arguments, and tool output. It retains only lifecycle metadata in `~/.intent-loop/events.jsonl`,
rotated at 5 MB with one previous segment.

## Install locally

```bash
npm install
npm run verify
npm run package:vsix
code --install-extension packages/vibecheck-0.6.7.vsix --force
```

Reload VS Code and open the VibeCheck icon in the Activity Bar.

Existing installations retain the extension ID `local.intent-loop`, command/settings prefix
`intentLoop.*`, and `.intent-loop/` configuration directory. These identifiers remain in place so
the rename does not discard workspace state, trusted commands, or existing configuration.

## Control-center workflow

1. Open a Git-backed workspace.
2. Use Codex, Claude, or manual editing normally; use VS Code Source Control for files and diffs.
3. Run a semantic review from **Review** and choose an explicit provider, model, and review depth.
4. Run individual quality gates or **Run all checks** whenever you need current evidence.
5. Inspect, accept, or dismiss high-signal deterministic findings in **Needs attention**.
6. Create an evidence report or copy a concrete agent follow-up.
7. Review repository agent capabilities and open or create their files under **Agent workspace**.
8. Commit normally. VibeCheck detects the new `HEAD` and begins monitoring uncommitted work against
   that commit automatically.

The readiness badge is deliberately conservative. Required checks must pass and high-risk findings
must be resolved. The sidebar also calls out missing test, coverage, or security categories.
The quality-gate overview shows the latest test totals, line coverage, and dependency-vulnerability
count at a glance. Each gate retains its structured result, run time, duration, and freshness state.
VibeCheck never stages or commits code, and it deliberately leaves file and diff UX to VS Code.

The Control Center is organized around five focused views:

- **Overview:** release readiness, the next recommended action, current metrics, and evidence export.
- **Review:** live Codex or Claude activity, elapsed time, structured findings, evidence links,
  freshness, a provider-neutral Markdown preview, and integrated account-limit snapshots from Codex
  `/status` and Claude `/usage`.
- **Quality:** detailed quality-gate results, structured metrics, timestamps, output, and configuration.
- **Attention:** unresolved and reviewed findings with explicit review decisions.
- **Workspace:** the active plan, repository agent capabilities, adapters, and local monitoring data.

The selected view and agent-workspace tab persist across refreshes, keeping the interface stable
while checks run or repository state changes.

## Agent workspace capabilities

The control center monitors documented repository surfaces rather than private transcripts or
machine-wide configuration. Its usage section invokes the providers' canonical `/status` and
`/usage` interfaces, normalizes only utilization/reset fields, and keeps the snapshot in memory:

- Codex: layered `AGENTS.md` files, `.agents/skills/**/SKILL.md`, `.codex/config.toml`,
  `.codex/hooks.json`, `.codex/rules/*.rules`, `.codex/agents/*.toml`, and Codex plugin manifests
  and hooks. Codex custom prompts are deprecated and user-scoped, so new reusable repository
  workflows are represented as skills.
- Claude: layered `CLAUDE.md` files, `.claude/rules/**/*.md`, `.claude/skills/**/SKILL.md`, legacy
  `.claude/commands/**/*.md`, `.claude/agents/*.md`, `.claude/settings*.json`, `.mcp.json`,
  `.claude/output-styles/*.md`, and Claude plugin manifests and hooks.
- VibeCheck: `.intent-loop/config.yaml`, `.intent-loop/rules.yaml`, and the active Markdown plan.

When `AGENTS.md` already exists, a newly created `CLAUDE.md` imports it with `@AGENTS.md` so shared
instructions are not duplicated. Personal Claude files are labeled local-only and should remain
gitignored. VibeCheck does not scan `~/.codex`, `~/.claude`, managed policy, installed plugin caches,
or runtime agent-team/task state; those are personal, administrative, installed, or ephemeral
surfaces rather than repository intent.

## Configuration

Run **VibeCheck: Open Local Configuration** or create `.intent-loop/config.yaml`:

```yaml
plans:
  include:
    - PLAN.md
    - plans/**/*.md
    - docs/**/*plan*.md
    - .claude/plans/*.md
  # active: plans/current.md  # Optional shared default

verification:
  - name: tests
    category: tests
    required: true
    command: npm test
    invalidated_by:
      - src/**
      - test/**
      - tests/**
      - package.json
      - package-lock.json

  - name: typecheck
    category: quality
    required: true
    command: npm run typecheck
    invalidated_by:
      - src/**
      - tsconfig.json

  - name: coverage threshold
    category: coverage
    required: true
    command: npm run coverage
    invalidated_by:
      - src/**
      - test/**

  - name: dependency security
    category: security
    required: true
    command: npm audit --audit-level=high
    invalidated_by:
      - package.json
      - package-lock.json

diff_expansion_threshold: 15
```

VibeCheck reads ordinary Markdown rather than introducing its own plan format. It extracts the
first heading, objective/goal/overview prose, and common task markers such as `[ ]`, `[x]`, and
`[~]`. The newest matching plan is selected automatically unless the repository config supplies an
`active` default or you choose a plan locally. Plan files must remain inside the observed repository;
the extension does not scan unrelated plans from home-directory agent storage.

Supported categories are `tests`, `coverage`, `security`, `quality`, `build`, and `other`. Commands
should enforce their own meaningful policy—for example, a coverage command should fail below the
repository's chosen threshold. Set `required: false` only when a check is genuinely advisory.

VibeCheck currently extracts structured metrics from Node TAP or Jest test summaries, c8/Istanbul
text or coverage-summary JSON, and npm-audit JSON or text. Use `npm audit --json` when possible:
the JSON package identifiers let VibeCheck distinguish newly introduced vulnerabilities from fixed
ones even when the total count is unchanged. Coverage movement and security changes are calculated
against the previous run of the same gate. Commands with unsupported output still receive normal
pass/fail, freshness, timing, raw-output, and readiness behavior.

Repository commands are never executed merely because the file exists. The exact command and
working directory are shown for approval, and trust is invalidated when the command changes.

Architecture boundaries live in `.intent-loop/rules.yaml`:

```yaml
boundaries:
  - name: input-does-not-depend-on-game
    from: src/input/**
    cannot_import:
      - src/game/**
```

Relative TypeScript and JavaScript imports are evaluated against these rules. Unsupported alias or
language resolution is not presented as a violation.

## Optional agent adapters

Repository mode does not require an agent adapter. To add lifecycle context, run one of:

- **VibeCheck: Install Local Codex Adapter**
- **VibeCheck: Install Local Claude Adapter**

The commands merge observer hooks into `~/.codex/hooks.json` or `~/.claude/settings.json` and install
the small bridge under `~/.intent-loop/bin/`. Existing hooks and settings are preserved.

Codex requires reviewing and trusting new non-managed hook definitions through `/hooks`. Remove
either integration with **VibeCheck: Remove Local Agent Adapter**.

Adapter behavior follows the current [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)
and [Claude Code hooks documentation](https://code.claude.com/docs/en/hooks). If an agent changes
its hook contract, repository mode continues operating independently.

## Finding semantics

- **Fact:** directly reproduced from local repository state.
- **Configured rule:** deterministic result of a repository-owned rule.
- **Heuristic:** useful but fallible signal requiring judgment.

Accepting a finding means the change is intentional. Dismissing means the signal is not useful for
the current evidence. If underlying evidence changes, a new fingerprint can create a new finding.

## Verification semantics

- **Not run:** no result exists for this command definition.
- **Running:** the local command is active.
- **Passed:** it exited successfully and relevant inputs still match their recorded hashes.
- **Failed:** it exited unsuccessfully or was interrupted.
- **Stale:** it previously passed, but a relevant file was added, removed, or changed.

The Markdown evidence report uses the same structured summaries shown in the Control Center and
includes the execution timestamp and duration for each quality gate.

A passing check is evidence for a particular repository state, not proof of complete product
behavior.

## Current limitations

- Only the first folder in a multi-root workspace is observed.
- Git metadata watching targets ordinary repositories; unusual external Git-dir layouts may require
  a manual refresh immediately after committing.
- Architecture enforcement currently resolves relative JavaScript and TypeScript imports only.
- Risk detection intentionally favors a small, explainable rule set over broad AI classification.
- Agent adapters report lifecycle awareness but do not manipulate another extension's chat UI.
- Plan progress is available when the Markdown contains checkbox-style tasks; narrative-only plans
  remain fully usable but do not receive a synthetic completion percentage.

See [DEVELOPMENT.md](./DEVELOPMENT.md) for development and testing instructions and [PLAN.md](./PLAN.md)
for the product roadmap.
