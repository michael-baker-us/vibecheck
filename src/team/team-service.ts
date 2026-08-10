/**
 * Roster lifecycle: seed, inspect, compile, apply, and remove.
 *
 * VibeCheck owns the roster and the files it compiles to. It does not launch, resume, or coordinate
 * the members themselves — the team is used from the developer's own Claude Code and Codex sessions.
 * That boundary is why this module writes files and reports drift, and does nothing else.
 *
 * Applying follows the Agent Workspace contract already used for instruction refreshes: preview
 * first, reject a stale preview, back up every replaced file outside the repository, and only then
 * write.
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
import { DEFAULT_TEAM } from "./default-team";
import {
  INSTRUCTIONS_PATH,
  claudeAgentPath,
  compileRoster,
  compileTeamBlock,
  enabledMembers,
  memberFingerprint,
  parseTeamWatermark,
  readTeamBlock,
} from "./team-compiler";
import { TEAM_ROSTER_PATH, TeamLoader, bodyPath } from "./team-loader";

export type TeamFilePreview = {
  path: string;
  originalContent?: string;
  proposedContent: string;
  status: "created" | "updated" | "unchanged";
};

export type TeamPreview = {
  files: TeamFilePreview[];
};

const CLAUDE_AGENT_DIRECTORY = ".claude/agents";

export type TeamApplyResult = {
  changedFiles: string[];
  backupDirectory?: string;
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

  public async preview(repositoryRoot: string, roster: TeamRoster): Promise<TeamPreview> {
    const instructions = await readOptional(path.join(repositoryRoot, INSTRUCTIONS_PATH));
    const compiled = compileRoster(roster, instructions ?? "");
    this.assertAllowed(compiled);
    const files = await Promise.all(compiled.map(async (file) => {
      const originalContent = await readOptional(path.join(repositoryRoot, file.path));
      const status: TeamFilePreview["status"] = originalContent === undefined
        ? "created"
        : originalContent === file.content ? "unchanged" : "updated";
      return {
        path: file.path,
        ...(originalContent === undefined ? {} : { originalContent }),
        proposedContent: file.content,
        status,
      };
    }));
    return { files };
  }

  /**
   * Also removes compiled agent files for members that are no longer in the roster or no longer
   * target Claude, so disabling a member actually withdraws it from the provider.
   */
  public async apply(
    repositoryRoot: string,
    preview: TeamPreview,
    backupRoot: string,
    orphans: string[] = [],
  ): Promise<TeamApplyResult> {
    const changed = preview.files.filter((file) => file.status !== "unchanged");
    for (const file of changed) {
      const current = await readOptional(path.join(repositoryRoot, file.path));
      if (current !== file.originalContent) {
        throw new Error(
          `${file.path} changed after the preview was generated. Generate a new preview before applying.`,
        );
      }
    }

    const backups = [
      ...changed
        .filter((file) => file.originalContent !== undefined)
        .map((file) => ({ path: file.path, content: file.originalContent! })),
      ...(await this.readAll(repositoryRoot, orphans)),
    ];
    let backupDirectory: string | undefined;
    if (backups.length) {
      backupDirectory = path.join(backupRoot, String(Date.now()));
      await mkdir(backupDirectory, { recursive: true });
      for (const file of backups) {
        const target = path.join(backupDirectory, file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content, "utf8");
      }
    }

    for (const file of changed) {
      const target = path.join(repositoryRoot, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.proposedContent, "utf8");
    }
    for (const orphan of orphans) {
      await rm(path.join(repositoryRoot, orphan), { force: true });
    }

    return {
      changedFiles: [...changed.map((file) => file.path), ...orphans],
      ...(backupDirectory ? { backupDirectory } : {}),
    };
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
    await this.loader.removeBody(repositoryRoot, memberId);
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

  public bodyPath(memberId: string): string {
    return bodyPath(memberId);
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

  private async readAll(repositoryRoot: string, paths: string[]): Promise<Array<{ path: string; content: string }>> {
    const files: Array<{ path: string; content: string }> = [];
    for (const relative of paths) {
      const content = await readOptional(path.join(repositoryRoot, relative));
      if (content !== undefined) files.push({ path: relative, content });
    }
    return files;
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
