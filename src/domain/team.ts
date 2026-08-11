export const TEAM_ROSTER_VERSION = 1 as const;

export type TeamTier = "fast" | "balanced" | "deep";

export type TeamToolProfile = "read-only" | "inspection" | "editing";

export type TeamProvider = "claude" | "codex";

export type TeamProviderPolicy =
  | "balanced-auto"
  | "prefer-claude"
  | "prefer-codex"
  | "claude-only"
  | "codex-only";

export type TeamProfile = "economy" | "balanced" | "maximum";

export const TEAM_TIERS: readonly TeamTier[] = ["fast", "balanced", "deep"];
export const TEAM_TOOL_PROFILES: readonly TeamToolProfile[] = ["read-only", "inspection", "editing"];
export const TEAM_PROVIDERS: readonly TeamProvider[] = ["claude", "codex"];
export const TEAM_PROVIDER_POLICIES: readonly TeamProviderPolicy[] = [
  "balanced-auto",
  "prefer-claude",
  "prefer-codex",
  "claude-only",
  "codex-only",
];
export const TEAM_PROFILES: readonly TeamProfile[] = ["economy", "balanced", "maximum"];

/**
 * Member identifiers become file names under `.claude/agents/`, so they must satisfy the
 * Agent Workspace path allowlist in `agent-instructions/refresh-service.ts`.
 */
export const TEAM_MEMBER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * The structured half of a member, owned by `.vibecheck/team.yaml`.
 *
 * The prose role prompt is deliberately not here: it is authored once, in the body of
 * `.claude/agents/<id>.md`, and VibeCheck only ever regenerates that file's frontmatter. Keeping a
 * second copy of the prompt was pure duplication, since it compiled to exactly one native target.
 */
export type TeamMember = {
  id: string;
  name: string;
  title: string;
  /** Drives provider delegation. This is the field that decides whether the member is ever used. */
  description: string;
  tier: TeamTier;
  tools: TeamToolProfile;
  providers: TeamProvider[];
  enabled: boolean;
};

export type TeamPolicy = {
  provider: TeamProviderPolicy;
  profile: TeamProfile;
};

export type TeamRoster = {
  version: typeof TEAM_ROSTER_VERSION;
  policy: TeamPolicy;
  members: TeamMember[];
};

export type TeamCompiledFile = {
  path: string;
  content: string;
  /** Absent for aggregate targets such as the managed AGENTS.md roster block. */
  memberId?: string;
};

/**
 * `modified` means the compiled file exists but no longer matches the roster it was generated
 * from, either because the roster moved on or because the file was hand-edited.
 */
export type TeamFileState = "missing" | "in-sync" | "modified";

export type TeamFileStatus = {
  path: string;
  state: TeamFileState;
};

export type TeamMemberStatus = {
  member: TeamMember;
  files: TeamFileStatus[];
};

export type TeamStatus = {
  policy: TeamPolicy;
  members: TeamMemberStatus[];
  roster: TeamFileStatus;
  instructions: TeamFileStatus;
};

export type TeamSnapshot =
  | { kind: "absent" }
  | { kind: "error"; reason: string }
  | { kind: "ready"; status: TeamStatus };
