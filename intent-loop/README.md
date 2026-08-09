# Intent Loop

**A local control center for AI-assisted coding in VS Code.**

Intent Loop observes repository changes, verification results, and optional Codex or Claude lifecycle
events on your machine. It surfaces risky changes and stale evidence, then helps you decide what to
inspect or ask the agent next.

You continue using Codex or Claude normally. Intent Loop does not proxy, replace, or remotely
monitor the agent.

## What it does

- Watches tracked and untracked changes relative to a Git baseline.
- Detects runtime dependency changes, weakened tests, sensitive files, binaries, generated files,
  broad diffs, and configured TypeScript/JavaScript architecture boundaries.
- Runs only explicitly configured and individually trusted local verification commands.
- Marks passing verification stale when its relevant input files change.
- Keeps an optional one-line working intent beside the current changes.
- Maintains an attention queue with fact, configured-rule, and heuristic provenance.
- Generates concrete follow-up prompts for the existing agent interface.
- Exports a local Markdown review.
- Optionally ingests normalized local Codex and Claude hook events.

## Local-only boundary

Intent Loop has no account, hosted backend, product telemetry, external LLM, or required network
connection. Repository contents, findings, command output, agent metadata, and reports stay on the
machine.

Codex and Claude may communicate with their own providers during normal use. Intent Loop adds no
upload path.

The optional hook bridge deliberately excludes prompt text, assistant messages, transcripts, tool
arguments, and tool output. It retains only lifecycle metadata in `~/.intent-loop/events.jsonl`,
rotated at 5 MB with one previous segment.

## Install locally

```bash
npm install
npm run verify
npm run package:vsix
code --install-extension intent-loop-0.1.0.vsix --force
```

Reload VS Code and open the Intent Loop icon in the Activity Bar.

## Basic workflow

1. Open a Git-backed workspace.
2. Set a short working intent if it would add context.
3. Use Codex, Claude, or manual editing normally.
4. Open **Needs attention** when the status bar changes.
5. Inspect, accept, or dismiss findings.
6. Run configured verification.
7. Copy a suggested follow-up prompt or export a review.

## Configuration

Run **Intent Loop: Open Local Configuration** or create `.intent-loop/config.yaml`:

```yaml
verification:
  - name: tests
    command: npm test
    invalidated_by:
      - src/**
      - test/**
      - tests/**
      - package.json
      - package-lock.json

  - name: typecheck
    command: npm run typecheck
    invalidated_by:
      - src/**
      - tsconfig.json

diff_expansion_threshold: 15
```

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

- **Intent Loop: Install Local Codex Adapter**
- **Intent Loop: Install Local Claude Adapter**

The commands merge observer hooks into `~/.codex/hooks.json` or `~/.claude/settings.json` and install
the small bridge under `~/.intent-loop/bin/`. Existing hooks and settings are preserved.

Codex requires reviewing and trusting new non-managed hook definitions through `/hooks`. Remove
either integration with **Intent Loop: Remove Local Agent Adapter**.

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

A passing check is evidence for a particular repository state, not proof of complete product
behavior.

## Current limitations

- Only the first folder in a multi-root workspace is observed.
- The baseline is a Git commit; resetting to `HEAD` does not hide existing uncommitted changes.
- Architecture enforcement currently resolves relative JavaScript and TypeScript imports only.
- Risk detection intentionally favors a small, explainable rule set over broad AI classification.
- Agent adapters report lifecycle awareness but do not manipulate another extension's chat UI.

See [DEVELOPMENT.md](./DEVELOPMENT.md) for development and testing instructions and [PLAN.md](./PLAN.md)
for the product roadmap.
