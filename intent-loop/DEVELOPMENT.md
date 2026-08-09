# Developing Intent Loop

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

## Run the M0 spike

1. Open the `intent-loop` directory as the root folder in VS Code.
2. Open **Run and Debug**.
3. Select **Run Intent Loop Extension**.
4. Press `F5`.
5. In the Extension Development Host, open a Git-backed project with at least one commit.
6. Open the Intent Loop Activity Bar view.

Intent Loop records the current `HEAD` as its baseline and lists tracked and untracked files that
differ from it. Edits made by VS Code, an integrated terminal, Codex, Claude, or another local
process should appear after the configured debounce interval.

## M0 commands

- `Intent Loop: Start Observing`
- `Intent Loop: Pause Observation`
- `Intent Loop: Refresh Workspace State`
- `Intent Loop: Reset Baseline to HEAD`
- `Intent Loop: Delete Local Observation Data`

The baseline is a Git commit, not a snapshot of uncommitted content. Resetting to `HEAD` therefore
does not hide existing uncommitted changes.

## Local data

Observation state is stored through VS Code's workspace storage. The extension does not make
network requests or emit product telemetry. **Delete Local Observation Data** removes the stored
state for the current VS Code workspace.

## M0 evaluation

Use the spike during a real Codex or Claude task and record:

- whether external edits appear accurately;
- whether the changed-file list remains current through rapid edits;
- whether Git refreshes are noticeable;
- whether pause, restart, and deletion behave predictably;
- which information would have changed how you interacted with the agent.

M0 intentionally does not analyze risks, run verification, or ingest agent hooks. Those capabilities
depend on the observer proving accurate and unobtrusive first.
