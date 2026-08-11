/**
 * Live team activity, read from the session transcripts Claude Code already writes locally.
 *
 * The hook bridge can only say that a tool ran. These transcripts say what a session is working on:
 * the title Claude keeps for the conversation, each delegation with the member and the task it was
 * given, and the file or command each tool call touched. That is the difference between "last tool
 * Bash" and "Cody is editing src/ui/status-bar.ts".
 *
 * Everything here is held in memory and rendered, never written to workspace state — the same
 * treatment the Live CLI review transcript already gets. Nothing read here is persisted, which is
 * what keeps prompts, task descriptions, and tool arguments out of stored state.
 */

import { readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";

import { TeamLiveDelegation, TeamLiveSession } from "../domain/team";

/** Only the tail of a transcript is parsed; sessions run long and the view only shows recent work. */
const TAIL_BYTES = 512 * 1024;
/** Sessions untouched for longer than this are not worth reading on every poll. */
const ACTIVE_WINDOW_MS = 3 * 60 * 60 * 1000;
const MAX_SESSIONS = 6;
const MAX_DELEGATIONS = 12;
const MAX_DETAIL_CHARS = 120;

const AUTHORIZATION_PATTERN = /\bauthorization\b(\s*:\s*|\s+)(?:bearer|basic)\s+[^\s"']+/gi;
const SECRET_PATTERN = /\b([A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|token|password|secret)[A-Za-z0-9_-]*)\b(\s*[:=]\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi;

/**
 * Claude stores transcripts under a directory named after the working directory, with path
 * non-alphanumeric path characters replaced by dashes.
 */
export function projectDirectoryName(repositoryRoot: string): string {
  return repositoryRoot.replace(/[^A-Za-z0-9]/g, "-");
}

type Record_ = { [key: string]: unknown };

const isRecord = (value: unknown): value is Record_ =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Folds one session's JSONL into a summary.
 *
 * Pure, so the whole shape of the live view is testable without a Claude installation. Lines that
 * do not parse are skipped: the tail of a live file routinely starts mid-record.
 */
export function parseClaudeSession(lines: readonly string[], repositoryRoot: string): TeamLiveSession | undefined {
  let sessionId: string | undefined;
  let title: string | undefined;
  let startedAt: string | undefined;
  let lastEventAt: string | undefined;
  let lastTool: string | undefined;
  let lastDetail: string | undefined;
  let toolCount = 0;
  const delegations = new Map<string, TeamLiveDelegation>();

  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;
    if (typeof entry.sessionId === "string") sessionId ??= entry.sessionId;
    if (entry.type === "ai-title" && typeof entry.aiTitle === "string") title = entry.aiTitle;

    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    if (timestamp) {
      startedAt ??= timestamp;
      lastEventAt = timestamp;
    }

    const message = isRecord(entry.message) ? entry.message : undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "tool_use") {
        const name = typeof block.name === "string" ? block.name : undefined;
        const input = isRecord(block.input) ? block.input : {};
        toolCount += 1;
        if (name) lastTool = name;
        lastDetail = toolDetail(input, repositoryRoot) ?? lastDetail;

        const member = typeof input.subagent_type === "string" ? input.subagent_type : undefined;
        const id = typeof block.id === "string" ? block.id : undefined;
        if (member && id && timestamp) {
          delegations.set(id, {
            id,
            member,
            ...(typeof input.description === "string"
              ? { description: bounded(input.description) }
              : {}),
            startedAt: timestamp,
          });
        }
      }
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        const delegation = delegations.get(block.tool_use_id);
        if (delegation && timestamp) {
          delegations.set(block.tool_use_id, { ...delegation, finishedAt: timestamp });
        }
      }
    }
  }

  if (!sessionId || !lastEventAt) return undefined;
  return {
    sessionId,
    ...(title ? { title: bounded(title) } : {}),
    startedAt: startedAt ?? lastEventAt,
    lastEventAt,
    ...(lastTool ? { lastTool } : {}),
    ...(lastDetail ? { lastDetail } : {}),
    toolCount,
    delegations: [...delegations.values()].slice(-MAX_DELEGATIONS),
  };
}

/**
 * The one useful argument per tool: what it acted on. Paths are made repository-relative, and
 * commands are redacted and truncated, because a transcript line is displayed verbatim.
 */
function toolDetail(input: Record_, repositoryRoot: string): string | undefined {
  if (typeof input.file_path === "string") return relative(input.file_path, repositoryRoot);
  if (typeof input.notebook_path === "string") return relative(input.notebook_path, repositoryRoot);
  if (typeof input.command === "string") return bounded(redactCommand(input.command));
  if (typeof input.pattern === "string") return bounded(input.pattern);
  if (typeof input.description === "string") return bounded(input.description);
  return undefined;
}

function redactCommand(command: string): string {
  return command
    .replace(AUTHORIZATION_PATTERN, "authorization: [REDACTED]")
    .replace(SECRET_PATTERN, "$1=[REDACTED]");
}

function relative(target: string, repositoryRoot: string): string {
  const value = path.isAbsolute(target) ? path.relative(repositoryRoot, target) : target;
  return bounded(value.startsWith("..") ? path.basename(target) : value);
}

function bounded(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > MAX_DETAIL_CHARS ? `${trimmed.slice(0, MAX_DETAIL_CHARS)}…` : trimmed;
}

export class ClaudeSessionReader {
  public constructor(private readonly home: string = homedir()) {}

  /**
   * Recently active sessions for this repository, most recent first. Returns an empty list when
   * Claude has never run here, which is not an error.
   */
  public async read(repositoryRoot: string, now: number = Date.now()): Promise<TeamLiveSession[]> {
    const directory = path.join(this.home, ".claude", "projects", projectDirectoryName(repositoryRoot));
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      return [];
    }

    const candidates: Array<{ file: string; modified: number }> = [];
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      try {
        const info = await stat(path.join(directory, entry));
        if (now - info.mtimeMs <= ACTIVE_WINDOW_MS) {
          candidates.push({ file: path.join(directory, entry), modified: info.mtimeMs });
        }
      } catch {
        // The file may vanish between listing and stat; skip it.
      }
    }

    const sessions: TeamLiveSession[] = [];
    for (const candidate of candidates.sort((a, b) => b.modified - a.modified).slice(0, MAX_SESSIONS)) {
      const session = parseClaudeSession(await this.tail(candidate.file), repositoryRoot);
      if (session) sessions.push(session);
    }
    return sessions.sort((left, right) => right.lastEventAt.localeCompare(left.lastEventAt));
  }

  /**
   * Reads the last chunk of a transcript. The first line is dropped when the file was truncated,
   * because it is almost certainly a partial record.
   */
  private async tail(file: string): Promise<string[]> {
    let size = 0;
    try {
      size = (await stat(file)).size;
    } catch {
      return [];
    }
    const start = Math.max(0, size - TAIL_BYTES);
    const lines: string[] = [];
    const stream = createReadStream(file, { start, end: Math.max(start, size - 1) });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of reader) lines.push(line);
    return start > 0 ? lines.slice(1) : lines;
  }
}
