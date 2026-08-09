---
name: repository-workflow
description: Work safely and consistently in the Companion/VibeCheck repository. Use for extension implementation, UI changes, Claude-Codex compatibility work, verification, packaging, or release preparation in this repository.
---

# Repository workflow

Work from `vibecheck/` unless the task targets repository-level agent configuration.

1. Inspect the relevant implementation, tests, and current Git changes before editing.
2. Preserve unrelated work and existing extension functionality.
3. Keep domain logic outside the webview when it can be tested independently.
4. Add or update focused tests with behavior changes.
5. Run `npm run check` and `npm test`; run `npm run verify` before packaging or release work.
6. Package with the repository's existing VSIX script and verify the installed extension version.

For Claude-Codex alignment, automatically mirror only portable open-standard skills and shared
Markdown guidance. Flag incompatible agents, MCP, hooks, permissions, or settings for explicit
review. Back up the destination before resolving a divergent skill copy.

