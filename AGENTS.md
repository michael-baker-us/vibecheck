# Companion Repository Guidance

## Scope

The active product is the VS Code extension in `vibecheck/` (VibeCheck). Treat this repository as
a long-lived developer-tool project: preserve behavior, keep provider integrations local-first, and
prefer maintainable boundaries over one-off UI logic.

## Working agreement

- Run extension commands from `vibecheck/`.
- Use `npm run check` for TypeScript validation and `npm test` for the test suite.
- Run `npm run verify` before packaging or handing off substantial changes.
- Keep UI actions reachable and keyboard-accessible; update source-level UI tests when controls move.
- Preserve user files and provider configuration. Back up a file before an explicit replacement and
  never silently translate incompatible Claude and Codex schemas.
- Keep shared guidance provider-neutral. Put provider-only behavior in the provider's own file.
- Update `vibecheck/README.md` when commands, settings, compatibility behavior, or workflows change.

## Claude and Codex compatibility

- `AGENTS.md` is the canonical shared repository guidance; `CLAUDE.md` imports it.
- Portable repository skills are mirrored between `.agents/skills/` and `.claude/skills/`.
- The active VibeCheck Markdown plan is shared context.
- Agents, MCP, hooks, permissions, and settings remain provider-specific unless a conversion is known
  to be lossless. Surface drift for review instead of overwriting either side.

