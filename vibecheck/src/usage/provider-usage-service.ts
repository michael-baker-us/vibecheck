import { execFile, spawn } from "node:child_process";

import { CodeReviewProvider } from "../domain/code-review";

const COMMAND_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 128 * 1024;

export type ProviderUsageWindow = {
  label: string;
  usedPercent: number;
  resetText?: string;
};

export type ProviderUsageResult = {
  provider: CodeReviewProvider;
  status: "ready" | "error";
  source: "/status" | "/usage";
  summary?: string;
  windows: ProviderUsageWindow[];
  fetchedAt: string;
  detail?: string;
};

export type ProviderUsageSnapshot = {
  status: "idle" | "loading" | "ready";
  providers: ProviderUsageResult[];
  updatedAt?: string;
};

export class ProviderUsageService {
  public emptySnapshot(): ProviderUsageSnapshot {
    return { status: "idle", providers: [] };
  }

  public loadingSnapshot(previous: ProviderUsageSnapshot): ProviderUsageSnapshot {
    return { ...previous, status: "loading" };
  }

  public async collect(): Promise<ProviderUsageSnapshot> {
    const providers = await Promise.all([
      this.collectCodex(),
      this.collectClaude(),
    ]);
    return { status: "ready", providers, updatedAt: new Date().toISOString() };
  }

  private async collectCodex(): Promise<ProviderUsageResult> {
    const fetchedAt = new Date().toISOString();
    try {
      const response = await readCodexRateLimits();
      return parseCodexStatus(response, fetchedAt);
    } catch (error) {
      return failed("codex", "/status", fetchedAt, error);
    }
  }

  private async collectClaude(): Promise<ProviderUsageResult> {
    const fetchedAt = new Date().toISOString();
    try {
      const output = await runClaudeUsage();
      return parseClaudeUsage(output, fetchedAt);
    } catch (error) {
      return failed("claude", "/usage", fetchedAt, error);
    }
  }
}

export function parseCodexStatus(value: unknown, fetchedAt = new Date().toISOString()): ProviderUsageResult {
  if (!isRecord(value) || !isRecord(value.rateLimits)) throw new Error("Codex returned no rate-limit status.");
  const snapshot = value.rateLimits;
  const windows = [
    parseCodexWindow("Primary window", snapshot.primary),
    parseCodexWindow("Secondary window", snapshot.secondary),
  ].filter((window): window is ProviderUsageWindow => Boolean(window));
  if (!windows.length) throw new Error("Codex /status did not report any usage windows.");
  const plan = typeof snapshot.planType === "string" ? snapshot.planType : undefined;
  return {
    provider: "codex",
    status: "ready",
    source: "/status",
    summary: plan ? `${capitalize(plan)} plan` : "Account rate limits",
    windows,
    fetchedAt,
  };
}

export function parseClaudeUsage(output: string, fetchedAt = new Date().toISOString()): ProviderUsageResult {
  const parsed = JSON.parse(output) as unknown;
  if (!isRecord(parsed) || parsed.is_error === true || typeof parsed.result !== "string") {
    throw new Error("Claude returned no /usage result.");
  }
  const lines = parsed.result.split("\n").map((line) => line.trim()).filter(Boolean);
  const windows: ProviderUsageWindow[] = [];
  for (const line of lines) {
    const match = line.match(/^(.+?):\s*(\d+(?:\.\d+)?)% used\s*[·-]\s*resets\s+(.+)$/i);
    if (!match) continue;
    windows.push({ label: match[1], usedPercent: Number(match[2]), resetText: match[3] });
  }
  if (!windows.length) throw new Error("Claude /usage did not report any usage windows.");
  return {
    provider: "claude",
    status: "ready",
    source: "/usage",
    summary: lines[0],
    windows,
    fetchedAt,
  };
}

function parseCodexWindow(label: string, value: unknown): ProviderUsageWindow | undefined {
  if (!isRecord(value) || typeof value.usedPercent !== "number") return undefined;
  const duration = typeof value.windowDurationMins === "number" ? value.windowDurationMins : undefined;
  const reset = typeof value.resetsAt === "number" ? new Date(value.resetsAt * 1_000) : undefined;
  return {
    label: duration ? `${durationLabel(duration)} ${label.toLowerCase()}` : label,
    usedPercent: value.usedPercent,
    resetText: reset && !Number.isNaN(reset.getTime()) ? reset.toISOString() : undefined,
  };
}

function durationLabel(minutes: number): string {
  if (minutes % 10_080 === 0) return `${minutes / 10_080}-week`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

function readCodexRateLimits(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const consume = (line: string) => {
      if (!line.trim()) return;
      try {
        const message = JSON.parse(line) as unknown;
        if (!isRecord(message)) return;
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
          child.stdin.write(`${JSON.stringify({ method: "account/rateLimits/read", id: 2 })}\n`);
        } else if (message.id === 2) {
          if (isRecord(message.error)) finish(new Error(String(message.error.message ?? "Codex status failed.")));
          else finish(undefined, message.result);
        }
      } catch {
        // Ignore non-protocol diagnostics.
      }
    };
    const timeout = setTimeout(() => finish(new Error("Codex /status timed out.")), COMMAND_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-MAX_OUTPUT_BYTES);
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      lines.forEach(consume);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-MAX_OUTPUT_BYTES); });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (!settled) finish(new Error(stderr.trim() || `Codex status process exited with ${code}.`));
    });
    child.stdin.write(`${JSON.stringify({
      method: "initialize",
      id: 1,
      params: { clientInfo: { name: "vibecheck", title: "VibeCheck", version: "0.6.7" }, capabilities: null },
    })}\n`);
  });
}

function runClaudeUsage(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("claude", [
      "-p", "/usage",
      "--output-format", "json",
      "--max-budget-usd", "0.000001",
      "--tools", "",
    ], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
}

function failed(
  provider: CodeReviewProvider,
  source: ProviderUsageResult["source"],
  fetchedAt: string,
  error: unknown,
): ProviderUsageResult {
  return {
    provider,
    source,
    status: "error",
    windows: [],
    fetchedAt,
    detail: error instanceof Error ? error.message : String(error),
  };
}

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
