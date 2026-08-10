/**
 * Reads and validates the team roster.
 *
 * The roster is split across two kinds of file so each is edited in its natural form: structured
 * fields live in `.vibecheck/team.yaml`, and each member's role prompt lives in
 * `.vibecheck/agents/<id>.md` as plain Markdown with no frontmatter. Frontmatter on the compiled
 * output is generated, never authored.
 *
 * Validation is strict and loud, matching `ConfigLoader`: a malformed roster is reported rather
 * than silently repaired, because the result is written into files the coding agents obey.
 */

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import * as path from "node:path";

import { parse, stringify } from "yaml";

import {
  TEAM_MEMBER_ID_PATTERN,
  TEAM_PROFILES,
  TEAM_PROVIDER_POLICIES,
  TEAM_PROVIDERS,
  TEAM_ROSTER_VERSION,
  TEAM_TIERS,
  TEAM_TOOL_PROFILES,
  TeamMember,
  TeamProfile,
  TeamProvider,
  TeamProviderPolicy,
  TeamRoster,
  TeamTier,
  TeamToolProfile,
} from "../domain/team";

export const TEAM_DIRECTORY = ".vibecheck";
export const TEAM_ROSTER_PATH = ".vibecheck/team.yaml";
export const TEAM_BODY_DIRECTORY = ".vibecheck/agents";

/** Guards against a pathological roster becoming an unreadable prompt in every session. */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MEMBERS = 24;

type RawMember = {
  id?: unknown;
  name?: unknown;
  title?: unknown;
  description?: unknown;
  tier?: unknown;
  tools?: unknown;
  providers?: unknown;
  enabled?: unknown;
};

type RawRoster = {
  version?: unknown;
  policy?: { provider?: unknown; profile?: unknown };
  members?: unknown;
};

export function bodyPath(memberId: string): string {
  return `${TEAM_BODY_DIRECTORY}/${memberId}.md`;
}

export class TeamLoader {
  /** Returns `undefined` when the repository has no roster, which is not an error. */
  public async load(repositoryRoot: string): Promise<TeamRoster | undefined> {
    const raw = await this.readYaml(path.join(repositoryRoot, TEAM_ROSTER_PATH));
    if (!raw) return undefined;

    if (raw.version !== undefined && raw.version !== TEAM_ROSTER_VERSION) {
      throw new Error(`${TEAM_ROSTER_PATH}: unsupported version ${String(raw.version)}.`);
    }
    const members = raw.members;
    if (members !== undefined && !Array.isArray(members)) {
      throw new Error(`${TEAM_ROSTER_PATH}: members must be an array.`);
    }
    const list = (members ?? []) as RawMember[];
    if (list.length > MAX_MEMBERS) {
      throw new Error(`${TEAM_ROSTER_PATH}: a roster may contain at most ${MAX_MEMBERS} members.`);
    }

    const seen = new Set<string>();
    const parsed: TeamMember[] = [];
    for (const [index, item] of list.entries()) {
      const at = `${TEAM_ROSTER_PATH}: members[${index}]`;
      const id = this.memberId(item?.id, `${at}.id`);
      if (seen.has(id)) throw new Error(`${at}.id: duplicate member id "${id}".`);
      seen.add(id);
      parsed.push({
        id,
        name: this.nonEmptyString(item.name, `${at}.name`),
        title: this.nonEmptyString(item.title, `${at}.title`),
        description: this.nonEmptyString(item.description, `${at}.description`),
        tier: this.oneOf(item.tier, TEAM_TIERS, `${at}.tier`) as TeamTier,
        tools: this.oneOf(item.tools, TEAM_TOOL_PROFILES, `${at}.tools`) as TeamToolProfile,
        providers: this.providers(item.providers, `${at}.providers`),
        enabled: item.enabled === undefined ? true : this.boolean(item.enabled, `${at}.enabled`),
        body: await this.readBody(repositoryRoot, id),
      });
    }

    return {
      version: TEAM_ROSTER_VERSION,
      policy: {
        provider: this.oneOf(
          raw.policy?.provider ?? "balanced-auto",
          TEAM_PROVIDER_POLICIES,
          `${TEAM_ROSTER_PATH}: policy.provider`,
        ) as TeamProviderPolicy,
        profile: this.oneOf(
          raw.policy?.profile ?? "balanced",
          TEAM_PROFILES,
          `${TEAM_ROSTER_PATH}: policy.profile`,
        ) as TeamProfile,
      },
      members: parsed,
    };
  }

  /**
   * Writes the roster back out. Structured fields go to `team.yaml` and bodies to their own files,
   * so the round trip through `load` is lossless.
   */
  public async save(repositoryRoot: string, roster: TeamRoster): Promise<void> {
    await mkdir(path.join(repositoryRoot, TEAM_BODY_DIRECTORY), { recursive: true });
    const document = {
      version: roster.version,
      policy: { provider: roster.policy.provider, profile: roster.policy.profile },
      members: roster.members.map((member) => ({
        id: member.id,
        name: member.name,
        title: member.title,
        description: member.description,
        tier: member.tier,
        tools: member.tools,
        providers: member.providers,
        enabled: member.enabled,
      })),
    };
    const header = [
      "# VibeCheck team roster.",
      "#",
      "# This file and .vibecheck/agents/*.md are the source of truth. VibeCheck compiles them into",
      "# .claude/agents/*.md and the managed Team block in AGENTS.md; edit those only through here.",
      "",
    ].join("\n");
    await writeFile(
      path.join(repositoryRoot, TEAM_ROSTER_PATH),
      `${header}${stringify(document, { lineWidth: 100 })}`,
      "utf8",
    );
    for (const member of roster.members) {
      await writeFile(
        path.join(repositoryRoot, bodyPath(member.id)),
        `${member.body.trim()}\n`,
        "utf8",
      );
    }
  }

  public async removeBody(repositoryRoot: string, memberId: string): Promise<void> {
    await rm(path.join(repositoryRoot, bodyPath(memberId)), { force: true });
  }

  private async readYaml(filePath: string): Promise<RawRoster | undefined> {
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const value = parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${TEAM_ROSTER_PATH} must contain a YAML object.`);
    }
    return value as RawRoster;
  }

  /**
   * A missing body file is tolerated: the roster still describes the member, and the compiler
   * falls back to a minimal role statement rather than failing the whole load.
   */
  private async readBody(repositoryRoot: string, memberId: string): Promise<string> {
    try {
      const body = await readFile(path.join(repositoryRoot, bodyPath(memberId)), "utf8");
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
        throw new Error(`${bodyPath(memberId)} exceeds ${MAX_BODY_BYTES / 1024} KB.`);
      }
      return body;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  private memberId(value: unknown, at: string): string {
    const id = this.nonEmptyString(value, at);
    if (!TEAM_MEMBER_ID_PATTERN.test(id)) {
      throw new Error(
        `${at}: "${id}" must be lowercase letters, digits, dots, dashes, or underscores, starting with a letter or digit.`,
      );
    }
    return id;
  }

  private providers(value: unknown, at: string): TeamProvider[] {
    if (value === undefined) return [...TEAM_PROVIDERS];
    if (!Array.isArray(value)) throw new Error(`${at} must be an array.`);
    if (value.length === 0) throw new Error(`${at} must list at least one provider.`);
    const providers = value.map((item, index) =>
      this.oneOf(item, TEAM_PROVIDERS, `${at}[${index}]`) as TeamProvider);
    return [...new Set(providers)];
  }

  private nonEmptyString(value: unknown, at: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${at} must be a non-empty string.`);
    return value.trim();
  }

  private oneOf(value: unknown, allowed: readonly string[], at: string): string {
    if (typeof value !== "string" || !allowed.includes(value)) {
      throw new Error(`${at} must be one of: ${allowed.join(", ")}.`);
    }
    return value;
  }

  private boolean(value: unknown, at: string): boolean {
    if (typeof value !== "boolean") throw new Error(`${at} must be true or false.`);
    return value;
  }
}
