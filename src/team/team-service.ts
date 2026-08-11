/**
 * Roster lifecycle: seed, inspect, deploy, and remove.
 *
 * VibeCheck owns the roster and the files it compiles to. It does not launch, resume, or coordinate
 * the members themselves — the team is used from the developer's own Claude Code and Codex sessions.
 * That boundary is why this module writes files and reports drift, and does nothing else.
 *
 * Team deployment is deliberately simpler than the reviewed Agent Workspace flow: deploy compiles
 * and writes the managed files, while undeploy deletes them. The roster remains the source of truth.
 */

import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { isAllowedWorkspacePath } from "../agent-instructions/refresh-service";
import {
  TeamCompiledFile,
  TeamFileState,
  TeamFileStatus,
  TeamMember,
  TeamMemberStatus,
  TeamRoster,
  TeamStatus,
} from "../domain/team";
import { DEFAULT_BODIES, DEFAULT_TEAM } from "./default-team";
import {
  INSTRUCTIONS_PATH,
  claudeAgentPath,
  compileRoster,
  compileTeamBlock,
  enabledMembers,
  extractBody,
  memberFingerprint,
  parseTeamWatermark,
  readTeamBlock,
  removeTeamBlock,
} from "./team-compiler";
import { TEAM_ROSTER_PATH, TeamLoader, legacyBodyPath } from "./team-loader";

const CLAUDE_AGENT_DIRECTORY = ".claude/agents";

export type TeamApplyResult = {
  changedFiles: string[];
};

export class TeamService {
  public constructor(private readonly loader: TeamLoader = new TeamLoader()) {}

  public async load(repositoryRoot: string): Promise<TeamRoster | undefined> {
    return this.loader.load(repositoryRoot);
  }

  /** Writes the default roster. Refuses to overwrite a roster that already exists. */
  public async seed(repositoryRoot: string): Promise<TeamRoster> {
    const existing = await this.loader.load(repositoryRoot);
    if (existing) {
      throw new Error(`${TEAM_ROSTER_PATH} already exists. Edit it directly, or delete it first.`);
    }
    await this.loader.save(repositoryRoot, DEFAULT_TEAM);
    return DEFAULT_TEAM;
  }

  /**
   * Adds any missing members from the default team to an existing roster.
   *
   * Existing entries win on id so a user-customized default member is never reset. This is kept
   * separate from `seed`, whose refusal to overwrite an existing roster protects the initial setup
   * path from silently replacing user configuration.
   */
  public async restoreDefaults(repositoryRoot: string, roster: TeamRoster): Promise<TeamRoster> {
    const existingIds = new Set(roster.members.map((member) => member.id));
    const missing = DEFAULT_TEAM.members.filter((member) => !existingIds.has(member.id));
    if (!missing.length) return roster;

    const next: TeamRoster = { ...roster, members: [...roster.members, ...missing] };
    await this.loader.save(repositoryRoot, next);
    return next;
  }

  /**
   * Compares the roster against the files on disk. `modified` covers both a roster that has moved
   * on and a compiled file that was hand-edited; the two are indistinguishable from the watermark
   * alone, and both mean the same thing to the user: applying will overwrite what is there.
   */
  public async status(repositoryRoot: string, roster: TeamRoster): Promise<TeamStatus> {
    const claudeIds = new Set(enabledMembers(roster, "claude").map((member) => member.id));
    const members: TeamMemberStatus[] = await Promise.all(
      roster.members.map(async (member) => ({
        member,
        files: claudeIds.has(member.id)
          ? [await this.claudeFileStatus(repositoryRoot, member)]
          : [],
      })),
    );
    return {
      policy: roster.policy,
      members,
      roster: { path: TEAM_ROSTER_PATH, state: "in-sync" },
      instructions: await this.instructionsStatus(repositoryRoot, roster),
    };
  }

  /** Compiles the roster and immediately writes its managed provider files. */
  public async deploy(repositoryRoot: string, roster: TeamRoster): Promise<TeamApplyResult> {
    await assertSafeAgentDirectory(repositoryRoot);
    await assertSafeRegularFileOrMissing(repositoryRoot, INSTRUCTIONS_PATH);
    const instructions = await readOptional(path.join(repositoryRoot, INSTRUCTIONS_PATH));
    const existing = await this.existingBodies(repositoryRoot, roster);
    const compiled = compileRoster(roster, instructions ?? "", existing, DEFAULT_BODIES);
    this.assertAllowed(compiled);
    const changed: TeamCompiledFile[] = [];
    for (const file of compiled) {
      await assertSafeRegularFileOrMissing(repositoryRoot, file.path);
      if (await readOptional(path.join(repositoryRoot, file.path)) !== file.content) changed.push(file);
    }

    const removals = [
      ...await this.orphans(repositoryRoot, roster),
      ...await this.legacyBodies(repositoryRoot, roster),
    ];
    for (const relative of removals) await assertSafeRegularFileOrMissing(repositoryRoot, relative);

    for (const file of changed) {
      const target = path.join(repositoryRoot, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }
    for (const relative of removals) await rm(path.join(repositoryRoot, relative), { force: true });

    return { changedFiles: [...changed.map((file) => file.path), ...removals] };
  }

  /** Deletes managed provider files while retaining the roster. */
  public async undeploy(repositoryRoot: string): Promise<TeamApplyResult> {
    const files: Array<{ path: string; proposedContent?: string }> = [];
    await assertSafeAgentDirectory(repositoryRoot);
    let entries: string[] = [];
    try {
      entries = await readdir(path.join(repositoryRoot, CLAUDE_AGENT_DIRECTORY));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".md")) continue;
      const relative = `${CLAUDE_AGENT_DIRECTORY}/${entry}`;
      await assertSafeRegularFileOrMissing(repositoryRoot, relative);
      const content = await readOptional(path.join(repositoryRoot, relative));
      if (content !== undefined && parseTeamWatermark(content)) files.push({ path: relative });
    }
    await assertSafeRegularFileOrMissing(repositoryRoot, INSTRUCTIONS_PATH);
    const instructions = await readOptional(path.join(repositoryRoot, INSTRUCTIONS_PATH));
    if (instructions !== undefined && readTeamBlock(instructions) !== undefined) {
      const proposedContent = removeTeamBlock(instructions);
      files.push({ path: INSTRUCTIONS_PATH, ...(proposedContent ? { proposedContent } : {}) });
    }
    for (const file of files) {
      const target = path.join(repositoryRoot, file.path);
      if (file.proposedContent === undefined) await rm(target, { force: true });
      else await writeFile(target, file.proposedContent, "utf8");
    }
    return { changedFiles: files.map((file) => file.path) };
  }

  /**
   * Compiled agent files with no matching enabled member, left behind when a member is removed,
   * disabled, or stops targeting Claude.
   *
   * Only files carrying the VibeCheck watermark are considered. Subagents the user wrote by hand
   * live in the same directory and must never be swept up by roster maintenance.
   */
  public async orphans(repositoryRoot: string, roster: TeamRoster): Promise<string[]> {
    const expected = new Set(enabledMembers(roster, "claude").map((member) => claudeAgentPath(member.id)));
    await assertSafeAgentDirectory(repositoryRoot);
    let entries: string[];
    try {
      entries = await readdir(path.join(repositoryRoot, CLAUDE_AGENT_DIRECTORY));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const found: string[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".md")) continue;
      const relative = `${CLAUDE_AGENT_DIRECTORY}/${entry}`;
      if (expected.has(relative)) continue;
      await assertSafeRegularFileOrMissing(repositoryRoot, relative);
      const content = await readOptional(path.join(repositoryRoot, relative));
      if (content !== undefined && parseTeamWatermark(content)) found.push(relative);
    }
    return found;
  }

  /** Removes a member from the roster, its body file, and its compiled agent file. */
  public async remove(repositoryRoot: string, roster: TeamRoster, memberId: string): Promise<TeamRoster> {
    if (!roster.members.some((member) => member.id === memberId)) {
      throw new Error(`No team member with id "${memberId}".`);
    }
    const next: TeamRoster = {
      ...roster,
      members: roster.members.filter((member) => member.id !== memberId),
    };
    await this.loader.save(repositoryRoot, next);
    return next;
  }

  public async setEnabled(
    repositoryRoot: string,
    roster: TeamRoster,
    memberId: string,
    enabled: boolean,
  ): Promise<TeamRoster> {
    if (!roster.members.some((member) => member.id === memberId)) {
      throw new Error(`No team member with id "${memberId}".`);
    }
    const next: TeamRoster = {
      ...roster,
      members: roster.members.map((member) =>
        member.id === memberId ? { ...member, enabled } : member),
    };
    await this.loader.save(repositoryRoot, next);
    return next;
  }

  public async add(repositoryRoot: string, roster: TeamRoster, member: TeamMember): Promise<TeamRoster> {
    if (roster.members.some((existing) => existing.id === member.id)) {
      throw new Error(`A team member with id "${member.id}" already exists.`);
    }
    const next: TeamRoster = { ...roster, members: [...roster.members, member] };
    await this.loader.save(repositoryRoot, next);
    return next;
  }

  /** Where a member's role prompt is authored. */
  public bodyPath(memberId: string): string {
    return claudeAgentPath(memberId);
  }

  /**
   * Current subagent file contents, keyed by member id, so the compiler can carry each authored body
   * through unchanged.
   *
   * Repositories created before the single-source refactor keep their prompts in
   * `.vibecheck/agents/`. Those are read once here, which migrates them into the subagent file on
   * the next apply; `legacyBodies` then reports them for removal.
   */
  private async existingBodies(
    repositoryRoot: string,
    roster: TeamRoster,
  ): Promise<Record<string, string>> {
    const bodies: Record<string, string> = {};
    for (const member of roster.members) {
      const relative = claudeAgentPath(member.id);
      await assertSafeRegularFileOrMissing(repositoryRoot, relative);
      const current = await readOptional(path.join(repositoryRoot, relative));
      if (current !== undefined && extractBody(current)) {
        bodies[member.id] = current;
        continue;
      }
      const legacy = await readOptional(path.join(repositoryRoot, legacyBodyPath(member.id)));
      if (legacy !== undefined && legacy.trim()) bodies[member.id] = legacy;
    }
    return bodies;
  }

  /** Legacy role-prompt files that the current deployment makes redundant. */
  public async legacyBodies(repositoryRoot: string, roster: TeamRoster): Promise<string[]> {
    const found: string[] = [];
    for (const member of roster.members) {
      const relative = legacyBodyPath(member.id);
      if (await readOptional(path.join(repositoryRoot, relative)) !== undefined) found.push(relative);
    }
    return found;
  }

  private async claudeFileStatus(repositoryRoot: string, member: TeamMember): Promise<TeamFileStatus> {
    const relative = claudeAgentPath(member.id);
    const content = await readOptional(path.join(repositoryRoot, relative));
    if (content === undefined) return { path: relative, state: "missing" };
    const watermark = parseTeamWatermark(content);
    const state: TeamFileState = watermark?.hash === memberFingerprint(member) ? "in-sync" : "modified";
    return { path: relative, state };
  }

  private async instructionsStatus(repositoryRoot: string, roster: TeamRoster): Promise<TeamFileStatus> {
    const content = await readOptional(path.join(repositoryRoot, INSTRUCTIONS_PATH));
    if (content === undefined) return { path: INSTRUCTIONS_PATH, state: "missing" };
    const block = readTeamBlock(content);
    if (block === undefined) return { path: INSTRUCTIONS_PATH, state: "missing" };
    return {
      path: INSTRUCTIONS_PATH,
      state: block === compileTeamBlock(roster) ? "in-sync" : "modified",
    };
  }

  /**
   * Defence in depth. The compiler only ever produces allowlisted paths, but the roster supplies
   * the member ids those paths are built from, so the result is checked against the same allowlist
   * the Agent Workspace flow uses before anything is written.
   */
  private assertAllowed(files: TeamCompiledFile[]): void {
    for (const file of files) {
      if (!isAllowedWorkspacePath(file.path)) {
        throw new Error(`Refusing to write unsupported Agent Workspace path: ${file.path}`);
      }
    }
  }

}

async function assertSafeAgentDirectory(repositoryRoot: string): Promise<void> {
  for (const relative of [".claude", CLAUDE_AGENT_DIRECTORY]) {
    let info;
    try { info = await lstat(path.join(repositoryRoot, relative)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Refusing to use unsafe team directory: ${relative}`);
    }
  }
}

async function assertSafeRegularFileOrMissing(repositoryRoot: string, relative: string): Promise<void> {
  let info;
  try { info = await lstat(path.join(repositoryRoot, relative)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Refusing to use unsafe team file: ${relative}`);
  }
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
