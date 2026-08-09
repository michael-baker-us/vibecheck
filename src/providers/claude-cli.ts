/**
 * Shared Claude CLI permission surface.
 *
 * Codex and Claude enforce permissions differently: Codex is given a sandbox and may run anything
 * the sandbox physically allows, while Claude is deny-by-default and matches each command against
 * an allowlist. Under `--print` there is no one to approve a miss, so anything absent from this
 * list fails outright. These lists exist so the two providers stay comparable and so the allowed
 * commands stay in step with what the prompts actually ask an agent to do.
 */

/** Repository inspection. Read-only: nothing here mutates the workspace or the network. */
const INSPECTION_BASH = [
  "Bash(cat *)",
  "Bash(ls *)",
  "Bash(find *)",
  "Bash(grep *)",
  "Bash(rg *)",
  "Bash(head *)",
  "Bash(tail *)",
  "Bash(wc *)",
  "Bash(git status *)",
  "Bash(git diff *)",
  "Bash(git log *)",
  "Bash(git show *)",
  "Bash(git ls-files *)",
];

/**
 * Package-manager reads used to confirm a command exists before configuring it as a gate.
 * `npm test` is listed separately because it is not an `npm run` invocation and would otherwise
 * be denied in the many repositories that use it.
 */
const PACKAGE_MANAGER_BASH = [
  "Bash(npm run *)",
  "Bash(npm test)",
  "Bash(npm audit *)",
  "Bash(npx *)",
  "Bash(yarn *)",
  "Bash(pnpm *)",
  "Bash(bun run *)",
];

/**
 * Permissions the user grants ahead of time, so a session does not stall on a denial that only a
 * human could have cleared. `verificationCommands` reuses a trust decision already made: those
 * commands are the repository's own configured gates, which VibeCheck runs on request today.
 */
export type AgentPermissionGrants = {
  /** Extra shell patterns from `vibecheck.agentAllowedCommands`. */
  commands: string[];
  /** Configured verification commands, when `vibecheck.agentMayRunVerificationCommands` is on. */
  verificationCommands: string[];
};

export const NO_AGENT_GRANTS: AgentPermissionGrants = { commands: [], verificationCommands: [] };

/**
 * Combines a base tool list with user grants into a `--allowed-tools` value.
 *
 * Verification commands are granted verbatim rather than as prefixes: the user trusted that exact
 * command, not everything sharing its first word.
 */
export function claudeTools(base: string, grants: AgentPermissionGrants = NO_AGENT_GRANTS): string {
  const granted = [
    ...grants.commands.map((pattern) => pattern.trim()).filter(Boolean),
    ...grants.verificationCommands.map((command) => command.trim()).filter(Boolean),
  ].map((pattern) => (/^[A-Z][A-Za-z]*(\(|$)/.test(pattern) ? pattern : `Bash(${pattern})`));
  return [...new Set([...base.split(","), ...granted])].join(",");
}

/** Read-only inspection with no file writes, for review and proposal workflows. */
export const CLAUDE_READ_ONLY_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  ...INSPECTION_BASH,
].join(",");

/** Read-only inspection plus package-manager reads. */
export const CLAUDE_INSPECTION_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  ...INSPECTION_BASH,
  ...PACKAGE_MANAGER_BASH,
].join(",");

/** Inspection plus the writes a configuration or workspace-file session needs. */
export const CLAUDE_EDITING_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Write",
  "Edit",
  ...INSPECTION_BASH,
  ...PACKAGE_MANAGER_BASH,
].join(",");

/**
 * Guidance appended to every Claude prompt.
 *
 * Compound commands are split by the permission layer and rejected as a whole when any part is
 * disallowed, and interpreters are not on the allowlist at all, so agents that reach for
 * `node -e` or `python3 -c` burn their turn on denials instead of doing the task.
 */
export const CLAUDE_TOOL_GUIDANCE = [
  "## Tool constraints",
  "",
  "- Run one command per tool call. Compound commands joined with `;`, `&&`, or `||` are rejected when any part is not permitted.",
  "- Interpreters such as `node -e`, `node script.js`, `python3 -c`, and `python3 script.py` are not permitted. Use the file-reading tools instead.",
  "- Reading files, listing directories, searching, and inspecting Git history are permitted.",
].join("\n");
