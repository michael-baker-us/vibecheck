import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";

export type ProviderUsage = {
  available: boolean;
  sessions: number;
  tokens: number;
  todayTokens: number;
  lastActivityAt?: string;
  sourceUpdatedAt?: string;
  rateLimit?: { usedPercent: number; resetsAt?: string; windowMinutes?: number };
  detail?: string;
};

export type AgentUsageSnapshot = {
  collectedAt: string;
  periodDays: 7;
  codex: ProviderUsage;
  claude: ProviderUsage;
};

type CollectorPaths = { codexSessions: string; claudeStats: string };

export class AgentUsageCollector {
  public constructor(private readonly paths: CollectorPaths = {
    codexSessions: path.join(homedir(), ".codex", "sessions"),
    claudeStats: path.join(homedir(), ".claude", "stats-cache.json"),
  }) {}

  public async collect(now = new Date()): Promise<AgentUsageSnapshot> {
    const dates = rollingDates(now, 7);
    const [codex, claude] = await Promise.all([
      this.collectCodex(dates),
      this.collectClaude(dates),
    ]);
    return { collectedAt: now.toISOString(), periodDays: 7, codex, claude };
  }

  private async collectCodex(dates: Set<string>): Promise<ProviderUsage> {
    const files = (await Promise.all([...dates].map(async (date) => {
      const [year, month, day] = date.split("-");
      const directory = path.join(this.paths.codexSessions, year, month, day);
      try {
        return (await readdir(directory, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map((entry) => path.join(directory, entry.name));
      } catch {
        return [];
      }
    }))).flat();

    let tokens = 0;
    let todayTokens = 0;
    let sessions = 0;
    let lastActivityAt: string | undefined;
    let latestRateAt = "";
    let rateLimit: ProviderUsage["rateLimit"];
    for (const file of files) {
      const usage = await readCodexSessionUsage(file);
      if (!usage) continue;
      sessions += 1;
      tokens += usage.tokens;
      if (usage.date === [...dates].at(-1)) todayTokens += usage.tokens;
      if (!lastActivityAt || usage.timestamp > lastActivityAt) lastActivityAt = usage.timestamp;
      if (usage.rateLimit && usage.timestamp > latestRateAt) {
        latestRateAt = usage.timestamp;
        rateLimit = usage.rateLimit;
      }
    }
    return files.length
      ? { available: true, sessions, tokens, todayTokens, lastActivityAt, rateLimit }
      : unavailable("No Codex session usage found in the last 7 days.");
  }

  private async collectClaude(dates: Set<string>): Promise<ProviderUsage> {
    try {
      const parsed = JSON.parse(await readFile(this.paths.claudeStats, "utf8")) as unknown;
      if (!isRecord(parsed)) return unavailable("Claude usage cache has an unsupported format.");
      const dailyTokens = Array.isArray(parsed.dailyModelTokens) ? parsed.dailyModelTokens : [];
      const dailyActivity = Array.isArray(parsed.dailyActivity) ? parsed.dailyActivity : [];
      const tokensByDate = new Map<string, number>();
      for (const item of dailyTokens) {
        if (!isRecord(item) || typeof item.date !== "string" || !dates.has(item.date) || !isRecord(item.tokensByModel)) continue;
        tokensByDate.set(item.date, Object.values(item.tokensByModel).reduce<number>(
          (sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? value : 0), 0));
      }
      let sessions = 0;
      for (const item of dailyActivity) {
        if (isRecord(item) && typeof item.date === "string" && dates.has(item.date) && typeof item.sessionCount === "number") {
          sessions += item.sessionCount;
        }
      }
      const today = [...dates].at(-1) ?? "";
      const sourceUpdatedAt = typeof parsed.lastComputedDate === "string" ? parsed.lastComputedDate : undefined;
      return {
        available: true,
        sessions,
        tokens: [...tokensByDate.values()].reduce((sum, value) => sum + value, 0),
        todayTokens: tokensByDate.get(today) ?? 0,
        lastActivityAt: [...tokensByDate.keys()].sort().at(-1),
        sourceUpdatedAt,
        detail: sourceUpdatedAt && !dates.has(sourceUpdatedAt) ? "Claude's local statistics cache is stale." : undefined,
      };
    } catch {
      return unavailable("Claude usage cache is not available. Run /usage in Claude Code for account limits.");
    }
  }
}

type CodexSessionUsage = {
  tokens: number;
  date: string;
  timestamp: string;
  rateLimit?: ProviderUsage["rateLimit"];
};

async function readCodexSessionUsage(file: string): Promise<CodexSessionUsage | undefined> {
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let latest: CodexSessionUsage | undefined;
  for await (const line of lines) {
    try {
      const event = JSON.parse(line) as unknown;
      if (!isRecord(event) || typeof event.timestamp !== "string" || !isRecord(event.payload)
        || event.payload.type !== "token_count" || !isRecord(event.payload.info)
        || !isRecord(event.payload.info.total_token_usage)) continue;
      const total = event.payload.info.total_token_usage.total_tokens;
      if (typeof total !== "number" || !Number.isFinite(total)) continue;
      latest = {
        tokens: total,
        date: event.timestamp.slice(0, 10),
        timestamp: event.timestamp,
        rateLimit: parseRateLimit(event.payload.rate_limits),
      };
    } catch {
      // Ignore provider diagnostics and partially-written trailing lines.
    }
  }
  return latest;
}

function parseRateLimit(value: unknown): ProviderUsage["rateLimit"] {
  if (!isRecord(value) || !isRecord(value.primary) || typeof value.primary.used_percent !== "number") return undefined;
  const resetsAt = typeof value.primary.resets_at === "number"
    ? new Date(value.primary.resets_at * 1_000).toISOString() : undefined;
  return {
    usedPercent: value.primary.used_percent,
    resetsAt,
    windowMinutes: typeof value.primary.window_minutes === "number" ? value.primary.window_minutes : undefined,
  };
}

function rollingDates(now: Date, days: number): Set<string> {
  const result = new Set<string>();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    result.add(date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0"));
  }
  return result;
}

function unavailable(detail: string): ProviderUsage {
  return { available: false, sessions: 0, tokens: 0, todayTokens: 0, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
