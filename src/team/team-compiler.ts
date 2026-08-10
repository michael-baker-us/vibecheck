/**
 * Compiles the provider-neutral team roster into the files the coding agents actually read.
 *
 * Two targets, chosen from what the installed CLIs support rather than from symmetry:
 *
 * - Claude Code reads native subagent definitions from `.claude/agents/<id>.md`, so each enabled
 *   member that opts into Claude compiles to one file.
 * - Codex has no file-based subagent definitions; its multi-agent support spawns subagents
 *   dynamically. The roster therefore reaches Codex through a managed block in `AGENTS.md`, which
 *   Codex loads for every session. That block is provider-neutral, so it also documents the team
 *   for Claude and for any future CLI that reads `AGENTS.md`.
 *
 * Everything here is pure: same roster in, byte-identical files out. Reading, writing, backing up,
 * and drift reporting all live in `team-service.ts`.
 */

import { createHash } from "node:crypto";

import {
  CLAUDE_EDITING_TOOLS,
  CLAUDE_INSPECTION_TOOLS,
  CLAUDE_READ_ONLY_TOOLS,
} from "../providers/claude-cli";
import {
  TeamCompiledFile,
  TeamMember,
  TeamRoster,
  TeamTier,
  TeamToolProfile,
} from "../domain/team";

export const TEAM_BLOCK_START = "<!-- vibecheck-team:start -->";
export const TEAM_BLOCK_END = "<!-- vibecheck-team:end -->";

export const INSTRUCTIONS_PATH = "AGENTS.md";

const WATERMARK_PATTERN = /^<!--\s*vibecheck-team:\s*id=([a-z0-9][a-z0-9._-]*);\s*hash=([0-9a-f]{16})\s*-->$/m;

/**
 * Model aliases rather than pinned identifiers, so compiled files keep working across model
 * releases. Explicit per-tier overrides arrive with the routing work in a later phase.
 */
const TIER_MODEL: Record<TeamTier, string> = {
  fast: "haiku",
  balanced: "sonnet",
  deep: "opus",
};

const TOOL_PROFILE_TOOLS: Record<TeamToolProfile, string> = {
  "read-only": CLAUDE_READ_ONLY_TOOLS,
  inspection: CLAUDE_INSPECTION_TOOLS,
  editing: CLAUDE_EDITING_TOOLS,
};

const TOOL_PROFILE_LABEL: Record<TeamToolProfile, string> = {
  "read-only": "reads the repository; makes no changes",
  inspection: "reads the repository and runs package-manager checks",
  editing: "reads and edits files, and runs package-manager checks",
};

export function claudeAgentPath(memberId: string): string {
  return `.claude/agents/${memberId}.md`;
}

/**
 * Identifies the roster fields the generated frontmatter was built from.
 *
 * The body is excluded on purpose: it is authored in place, so editing it must never be reported as
 * drift. Only frontmatter is VibeCheck's to own.
 */
export function memberFingerprint(member: TeamMember): string {
  return createHash("sha256")
    .update(member.description).update("\0")
    .update(member.tier).update("\0")
    .update(member.tools).update("\0")
    .digest("hex")
    .slice(0, 16);
}

export function rosterFingerprint(roster: TeamRoster): string {
  const hash = createHash("sha256");
  for (const member of rosterMembers(roster)) {
    hash.update(member.id).update("\0").update(member.name).update("\0");
    hash.update(member.title).update("\0").update(member.description).update("\0");
    hash.update(member.tools).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

export function parseTeamWatermark(content: string): { id: string; hash: string } | undefined {
  const match = WATERMARK_PATTERN.exec(content);
  return match ? { id: match[1], hash: match[2] } : undefined;
}

/**
 * The roster as documented in `AGENTS.md`: every enabled member, regardless of provider. The block
 * is repository documentation loaded by every CLI, so it describes the whole team.
 */
export function rosterMembers(roster: TeamRoster): TeamMember[] {
  return roster.members.filter((member) => member.enabled);
}

/**
 * Members that compile to a provider-native definition. `providers` and the provider policy narrow
 * this, which is why it is separate from what `AGENTS.md` documents.
 */
export function enabledMembers(roster: TeamRoster, provider: "claude" | "codex"): TeamMember[] {
  const policy = roster.policy.provider;
  if (provider === "claude" && policy === "codex-only") return [];
  if (provider === "codex" && policy === "claude-only") return [];
  return rosterMembers(roster).filter((member) => member.providers.includes(provider));
}

/**
 * Rebuilds a member's subagent file: generated frontmatter over the body already in the file.
 *
 * `existing` is the current file contents, if any. Its body is carried through verbatim so the
 * prompt the user wrote is never overwritten by a roster edit.
 */
export function compileClaudeAgent(member: TeamMember, existing?: string, fallbackBody?: string): string {
  const frontmatter = [
    "---",
    `name: ${member.id}`,
    `description: ${quoteYaml(collapse(member.description))}`,
    `tools: ${quoteYaml(TOOL_PROFILE_TOOLS[member.tools])}`,
    `model: ${TIER_MODEL[member.tier]}`,
    "---",
  ].join("\n");
  const watermark = `<!-- vibecheck-team: id=${member.id}; hash=${memberFingerprint(member)} -->`;
  const authored = (existing === undefined ? undefined : extractBody(existing))
    || fallbackBody?.trim()
    || `You are ${member.name}, the ${member.title.toLowerCase()} for this repository.`;
  return `${frontmatter}\n${watermark}\n\n${authored}\n`;
}

/**
 * The authored prose of a subagent file: everything after the frontmatter, minus the watermark.
 * Files without frontmatter are treated as body-only, so a hand-written subagent adopted into the
 * roster keeps its content.
 */
export function extractBody(content: string): string {
  const withoutFrontmatter = /^---\n[\s\S]*?\n---\n?/.test(content)
    ? content.replace(/^---\n[\s\S]*?\n---\n?/, "")
    : content;
  return withoutFrontmatter.replace(WATERMARK_PATTERN, "").trim();
}

/**
 * The roster block written into `AGENTS.md`. Kept to a compact summary: the block is loaded into
 * every session in the repository, so it states who exists and when to use them, and leaves the
 * full role prompts in the per-member files.
 */
export function compileTeamBlock(roster: TeamRoster): string {
  const members = rosterMembers(roster);
  const lines = [
    TEAM_BLOCK_START,
    "<!-- Generated by VibeCheck from .vibecheck/team.yaml. Edit that file, not this block. -->",
    "",
    "## Team",
    "",
    `This repository defines a persistent engineering team (hash \`${rosterFingerprint(roster)}\`).`,
    "Use the smallest team capable of doing the work well; for trivial changes, proceed directly.",
    "",
  ];
  if (members.length === 0) {
    lines.push("No team members are currently enabled.", "");
  } else {
    for (const member of members) {
      lines.push(
        `- **${member.name}** — ${member.title}. ${collapse(member.description)} _(${TOOL_PROFILE_LABEL[member.tools]})_`,
      );
    }
    lines.push("");
    lines.push(
      "Full role definitions live in `.vibecheck/agents/`. Claude Code additionally loads these as native subagents from `.claude/agents/`.",
      "",
    );
  }
  lines.push(TEAM_BLOCK_END);
  return lines.join("\n");
}

/**
 * Replaces the managed block in an existing `AGENTS.md`, or appends it when absent. Content outside
 * the markers is never touched — the file is hand-written repository guidance that happens to carry
 * a generated region.
 */
export function applyTeamBlock(existing: string, block: string): string {
  const start = existing.indexOf(TEAM_BLOCK_START);
  const end = existing.indexOf(TEAM_BLOCK_END);
  if (start !== -1 && end !== -1 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + TEAM_BLOCK_END.length);
    return `${before}${block}${after}`;
  }
  const base = existing.replace(/\s+$/, "");
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

export function readTeamBlock(existing: string): string | undefined {
  const start = existing.indexOf(TEAM_BLOCK_START);
  const end = existing.indexOf(TEAM_BLOCK_END);
  if (start === -1 || end === -1 || end < start) return undefined;
  return existing.slice(start, end + TEAM_BLOCK_END.length);
}

/**
 * Every file the roster owns. Current file contents are passed in rather than read so this stays
 * pure: `existingAgents` maps member id to the current subagent file, and `fallbackBodies` supplies
 * a starting prompt for members that have no file yet.
 */
export function compileRoster(
  roster: TeamRoster,
  existingInstructions: string,
  existingAgents: Readonly<Record<string, string>> = {},
  fallbackBodies: Readonly<Record<string, string>> = {},
): TeamCompiledFile[] {
  const files: TeamCompiledFile[] = enabledMembers(roster, "claude").map((member) => ({
    path: claudeAgentPath(member.id),
    content: compileClaudeAgent(member, existingAgents[member.id], fallbackBodies[member.id]),
    memberId: member.id,
  }));
  files.push({
    path: INSTRUCTIONS_PATH,
    content: applyTeamBlock(existingInstructions, compileTeamBlock(roster)),
  });
  return files;
}

/** Collapses prose to a single line so it is safe in YAML frontmatter and in a Markdown list item. */
function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Emits a double-quoted YAML scalar. Frontmatter values carry prose with colons and commas, both of
 * which change meaning unquoted.
 */
function quoteYaml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
