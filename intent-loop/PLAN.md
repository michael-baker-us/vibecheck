# VibeCheck Implementation Plan

## Implementation status — 2026-08-09

Version 0.5.0 adopts the VibeCheck product name while retaining the established extension ID,
command/settings keys, workspace-state keys, and `.intent-loop/` paths for compatibility.

Version 0.4.0 implements the complete local repository-mode vertical slice and its first
product-facing control center:

- M0 repository observation, baseline state, native VS Code UI, and persistence;
- M1 deterministic findings, provenance, lifecycle, diagnostics, and evidence navigation;
- M2 trusted local verification, output redaction, input hashing, and freshness invalidation;
- M3 plan-aware follow-up prompts, finding resolution, and Markdown review export;
- M4/M5 optional local Claude and Codex lifecycle adapters using bounded normalized JSONL events;
- M6 configured path boundaries for relative TypeScript and JavaScript imports.
- M7 guided sidebar workflow, explicit quality-gate categories, and continuous readiness.
- M8 repository Markdown plan discovery, progress extraction, and local active-plan selection.
- M9 automatic commit-boundary tracking, evidence reporting, and Codex/Claude workspace file management.

Remaining work is product validation and hardening rather than missing core workflow: sustained
dogfooding, VS Code-host integration automation, multi-root support, performance measurement on
large repositories, richer language resolution, and adapter compatibility testing across agent
releases.

## Objective

Validate and build a local VS Code extension that observes AI-assisted repository changes, detects
high-confidence risks and stale verification, and helps a developer decide when and how to
intervene.

The implementation should prove usefulness in repository mode before investing in Codex or Claude
integration.

## Product constraints

- Local operation only; no backend, account, telemetry pipeline, or required network access.
- Users keep their existing Codex, Claude, terminal, and VS Code workflows.
- The extension never needs to launch or proxy an agent.
- Deterministic findings take priority over LLM interpretation.
- Agent adapters are optional and independently replaceable.
- The UI should feel native to VS Code; a scoped sidebar webview is acceptable where it materially
  improves workflow clarity and direct actionability.
- Captured data is inspectable and deletable.
- Performance overhead must be unnoticeable during ordinary editing.

## Key product hypothesis

Developers using coding agents will voluntarily keep a local observer enabled if it provides
actionable information that their agent's final response and normal Git diff do not make obvious.

The extension must therefore optimize for unique, decision-relevant findings rather than the
amount of activity collected.

## Measures of usefulness

Evaluate the prototype through deliberate dogfooding rather than product telemetry.

For each real task, record locally:

- whether VibeCheck produced a finding;
- whether the finding was already obvious from the agent's final response;
- whether it caused a follow-up, code change, or additional verification;
- whether it reduced the amount of diff reviewed;
- false positives and dismissed findings;
- time spent configuring and interpreting the extension.

Initial targets:

- less than 15 seconds to begin observing a workspace;
- no required duplicate task description;
- less than 30 seconds to understand the attention queue;
- fewer than one distracting high-severity false positive per ten sessions;
- at least one decision-relevant finding across several nontrivial sessions;
- no perceptible editor slowdown in a representative medium-sized repository.

These are discovery targets, not permanent service-level objectives.

## Technical shape

### Extension modules

```text
src/
  extension.ts               activation and composition root
  domain/
    events.ts                normalized event types
    findings.ts              finding model and lifecycle
    verification.ts          verification freshness model
  collectors/
    workspace-watcher.ts     file create/change/delete events
    git-collector.ts         baseline, status, diff, and file metadata
    verification-runner.ts   explicit local commands
  analyzers/
    stale-verification.ts
    dependency-change.ts
    test-integrity.ts
    sensitive-files.ts
    diff-expansion.ts
  storage/
    workspace-store.ts       private extension state
    event-log.ts             bounded local JSONL storage
  ui/
    status-bar.ts
    findings-tree.ts
    diagnostics.ts
    commands.ts
  prompts/
    follow-up-builder.ts     deterministic prompt templates
  adapters/
    codex/                   post-MVP
    claude/                  post-MVP
```

Keep analyzers as pure functions where possible:

```ts
analyze(snapshotBefore, snapshotAfter, configuration): Finding[]
```

This makes them testable without running VS Code or an agent.

### Core models

A finding should record provenance and resolution rather than only severity:

```ts
type Finding = {
  id: string;
  ruleId: string;
  title: string;
  explanation: string;
  severity: "info" | "medium" | "high";
  basis: "fact" | "configured-rule" | "heuristic";
  evidence: EvidenceReference[];
  status: "open" | "accepted" | "resolved" | "dismissed";
  firstObservedAt: string;
  lastObservedAt: string;
};
```

Verification freshness should be derived from recorded inputs, not wall-clock ordering alone. A run
stores the hashes or Git state of relevant files; later changes invalidate the affected result.

### Storage

Use VS Code workspace storage for private session state. Use `.intent-loop/` only for configuration
that a user intentionally shares with the repository.

Begin with versioned JSON and bounded JSONL:

```text
workspace-state/
  state.v1.json
  events.v1.jsonl
```

Add a storage interface early so SQLite can replace the implementation later without affecting
collectors or analyzers.

## Milestones

### M0 — Feasibility spike

Goal: prove that the extension can observe a worktree and surface state without disrupting editing.

Build:

- minimal TypeScript VS Code extension scaffold;
- activation only for workspaces containing a Git repository;
- baseline Git revision and dirty-state capture;
- debounced file watcher;
- one status-bar item;
- one Tree View listing changed files;
- local workspace-state persistence;
- commands to start, pause, reset, and delete observation data.

Verify:

- external edits made by an integrated-terminal agent are observed;
- rapid save sequences do not trigger repeated Git scans;
- ignored directories such as `.git`, dependency caches, and build output do not create noise;
- multi-root workspaces fail clearly or are intentionally unsupported for the spike;
- extension restart restores the active baseline.

Exit criteria:

- file and Git state remain correct through a complete manual Codex or Claude task;
- no material CPU spike while the workspace is idle;
- reset and deletion remove all session state.

### M1 — Deterministic findings

Goal: establish an attention queue with signals that are useful without agent integration.

Implement these analyzers:

1. Runtime dependency added.
2. Test deleted or newly skipped/focused.
3. Sensitive configuration file changed.
4. Generated or binary file added.
5. Diff expansion beyond a configurable threshold.

Build:

- finding lifecycle and deduplication;
- severity and provenance labels;
- Tree View groups for open, accepted, and dismissed findings;
- commands to inspect evidence and mark a change intentional;
- Problems-panel diagnostics only for exact file/range findings;
- unit tests using repository snapshots and fixtures.

Exit criteria:

- findings are reproducible from stored snapshots;
- dismissed findings do not immediately reappear unless their evidence materially changes;
- every finding links to inspectable local evidence;
- dogfooding produces an acceptable signal-to-noise ratio before adding more rules.

### M2 — Verification freshness

Goal: make “tests passed” a precise, time-sensitive statement.

Build:

- `.intent-loop/config.yaml` verification configuration;
- explicit command runner with visible command and working directory;
- exit code, duration, output summary, and relevant input hashes;
- PASS, FAIL, STALE, RUNNING, and NOT RUN states;
- invalidation when relevant files change;
- per-command include/exclude patterns;
- command-output retention and redaction controls;
- status-bar summary of stale or failing checks.

Example configuration:

```yaml
verification:
  - name: unit-tests
    command: npm test
    invalidated_by:
      - src/**
      - tests/**
      - package.json
      - package-lock.json

  - name: typecheck
    command: npm run typecheck
    invalidated_by:
      - src/**
      - tsconfig.json
```

Security boundary:

- never infer and execute an arbitrary command without confirmation;
- make repository-provided commands visible before first execution;
- store trust against the exact configured command;
- require renewed confirmation if it changes.

Exit criteria:

- editing a relevant source file reliably makes the appropriate result stale;
- unrelated documentation changes do not invalidate narrowly configured checks;
- failed and interrupted commands leave coherent state;
- users can inspect exactly what ran and why it is current or stale.

### M3 — Intervention workflow

Goal: turn findings into better developer-agent interaction.

Build:

- alignment with an existing repository Markdown plan, with no duplicate intent field;
- deterministic follow-up prompt templates;
- `Copy Suggested Agent Prompt` action;
- combined prompt for selected findings;
- commands to inspect, accept, dismiss, or resolve findings;
- local Markdown review export;
- clear labeling of facts, configured rules, and heuristics.

Do not add an external LLM. Prompt generation should initially be templated from the finding and its
evidence.

Exit criteria:

- generated prompts contain concrete file, check, and risk context;
- prompts request explanation or verification without asserting uncertain conclusions;
- dogfooding shows that users send or adapt generated prompts voluntarily.

### M4 — Claude adapter

Goal: enrich repository findings using Claude's documented lifecycle hooks without making them a
dependency.

Start with:

- session start and end;
- user prompt submission;
- tool completion for edit and shell operations;
- turn stop;
- local normalized event ingestion.

Implementation preference:

- a small, inspectable local hook command;
- append-only JSONL transport in a user-only data directory;
- no localhost network listener for the first adapter;
- explicit installation, permission explanation, and uninstall command;
- raw prompt or transcript retention disabled by default.

Exit criteria:

- repository mode behaves identically when hooks are missing or disabled;
- hook events correlate to the correct workspace and session;
- removing the adapter leaves no active configuration behind;
- captured fields are visible and deletable from the extension.

### M5 — Codex adapter

Goal: provide the same normalized lifecycle enrichment for Codex.

Implement against documented Codex hooks rather than private VS Code extension internals. Normalize
only the fields needed by the analysis engine.

Exit criteria mirror M4, plus:

- terminal and IDE Codex workflows are tested separately where supported;
- adapter version incompatibility degrades visibly to repository mode;
- the extension never requires control over the Codex sidebar or chat composer.

### M6 — Configured architecture rules

Goal: allow repositories to encode high-value boundaries without presenting inference as fact.

Build:

- schema and validation for `.intent-loop/rules.yaml`;
- initial path-based boundaries;
- TypeScript import analysis as the first language-specific adapter;
- evidence links from a rule finding to both configuration and source import;
- repository fixtures and performance benchmarks.

Delay generalized AST support until one language adapter proves valuable.

## Testing strategy

### Unit tests

- event normalization;
- Git snapshot comparison;
- every deterministic analyzer;
- finding lifecycle and deduplication;
- verification invalidation;
- follow-up prompt generation;
- configuration parsing and migration.

### Integration tests

Create temporary fixture repositories and exercise:

- baseline creation;
- file changes and Git diffs;
- dependency modifications;
- test removal and skip additions;
- passing, failing, stale, and interrupted verification;
- extension-state restart and deletion;
- malformed or partial agent events.

### VS Code extension tests

- activation and deactivation;
- commands and Tree View refresh;
- status-bar state changes;
- diagnostics creation and removal;
- workspace trust behavior;
- local storage cleanup.

### Performance tests

Benchmark against small and medium fixture repositories:

- idle CPU usage;
- change-to-finding latency;
- Git scan duration;
- memory growth over a long session;
- event-log retention and compaction.

## Risks and mitigations

### Duplicate information

Risk: the extension repeats Git and agent summaries.

Mitigation: only surface changed state, stale evidence, explicit rules, and prioritized review
recommendations. Do not make a chronological feed the default view.

### False positives

Risk: vague scope and architecture warnings train users to ignore the extension.

Mitigation: begin with deterministic signals, label heuristics, allow intentional changes to be
accepted, and measure dismissals during dogfooding.

### Performance overhead

Risk: recursive file watching and frequent Git scans degrade VS Code.

Mitigation: use VS Code exclusions, debounce and coalesce events, scan on state boundaries, cache
snapshots, and establish performance budgets in M0.

### Unsafe verification commands

Risk: repository configuration causes unexpected local execution.

Mitigation: require explicit trust for exact commands, show the working directory, and invalidate
trust when configuration changes.

### Agent integration churn

Risk: Codex or Claude lifecycle schemas change.

Mitigation: isolate adapters, retain a small versioned normalized model, validate incoming payloads,
and always degrade to repository mode.

### Sensitive local data

Risk: prompts, commands, or output contain secrets.

Mitigation: minimize captured fields, disable raw payload persistence by default, redact retained
output, restrict local file permissions, bound retention, and make deletion easy.

## Explicitly deferred

- Separate desktop application
- Hosted accounts or synchronization
- Team dashboards
- Remote telemetry or analytics
- Direct manipulation of Codex or Claude chat interfaces
- External LLM classification
- Generic multi-language AST analysis
- CI and pull-request integrations
- Autonomous blocking or approval decisions
- Opaque readiness scores

## First engineering decision

Start with M0 and dogfood it during real work before implementing the full event model. The first
decision gate is whether a quiet VS Code observer can remain accurate and unobtrusive while Codex or
Claude edits the repository through both an IDE extension and an integrated terminal.
