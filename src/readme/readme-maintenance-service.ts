import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { CodeReviewSelection, CodeReviewTranscriptEntry } from "../domain/code-review";
import {
  ReadmeMaintenanceMode,
  ReadmeMaintenanceRequest,
  ReadmeMaintenanceResult,
} from "../domain/readme-maintenance";
import { normalizeReviewTranscriptEvent } from "../reviews/code-review-service";

const README_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_README_BYTES = 2 * 1024 * 1024;
const WATERMARK_PATTERN = /^<!-- vibecheck-readme: reviewed-at=([^;]+); commit=([0-9a-f]{40,64}) -->\r?$/gm;
const WATERMARK_LINE_PATTERN = /^<!-- vibecheck-readme:.*-->\r?$/gm;
const execFileAsync = promisify(execFile);

const README_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    content: { type: "string" },
  },
  required: ["summary", "content"],
} as const;

export type ReadmeProgress = { label: string; detail?: string };
export type ReadmeProviderRunner = (
  provider: CodeReviewSelection["provider"],
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  onProgress?: (progress: ReadmeProgress) => void,
  onTranscript?: (entry: Omit<CodeReviewTranscriptEntry, "at">) => void,
) => Promise<unknown[]>;
export type ReadmeGitRunner = (args: string[], cwd: string) => Promise<string>;

export class ReadmeMaintenanceService {
  public constructor(
    private readonly runner: ReadmeProviderRunner = runProvider,
    private readonly gitRunner: ReadmeGitRunner = runGit,
  ) {}

  public async run(
    selection: CodeReviewSelection,
    repositoryRoot: string,
    signal?: AbortSignal,
    onProgress?: (progress: ReadmeProgress) => void,
    onTranscript?: (entry: Omit<CodeReviewTranscriptEntry, "at">) => void,
  ): Promise<ReadmeMaintenanceRequest & ReadmeMaintenanceResult> {
    const headCommit = (await this.gitRunner(["rev-parse", "--verify", "HEAD"], repositoryRoot)).trim();
    const readmePath = path.join(repositoryRoot, "README.md");
    const before = await readOptionalText(readmePath);
    const watermark = parseReadmeWatermark(before);
    const baseCommit = watermark && await this.isAncestor(repositoryRoot, watermark.commit, headCommit)
      ? watermark.commit
      : undefined;
    const request: ReadmeMaintenanceRequest = {
      ...selection,
      headCommit,
      mode: baseCommit ? "incremental" : "full",
      baseCommit,
    };
    onProgress?.({
      label: request.mode === "incremental" ? "Reviewing changes since the README watermark" : "Reviewing the whole repository",
      detail: request.baseCommit?.slice(0, 12),
    });
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "vibecheck-readme-"));
    const schemaPath = path.join(temporaryDirectory, "schema.json");
    const resultPath = path.join(temporaryDirectory, "result.json");
    let result: ReadmeMaintenanceResult;
    try {
      await writeFile(schemaPath, JSON.stringify(README_SCHEMA), "utf8");
      const args = selection.provider === "codex"
        ? codexReadmeArguments(request, schemaPath, resultPath)
        : claudeReadmeArguments(request);
      const events = await this.runner(selection.provider, args, repositoryRoot, signal, onProgress, onTranscript);
      const raw = selection.provider === "codex"
        ? await readFile(resultPath, "utf8")
        : JSON.stringify([...events].reverse().find((event) => isRecord(event) && event.type === "result")) ?? "";
      result = parseReadmeOutput(raw);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }

    if (await readOptionalText(readmePath) !== before) {
      throw new Error("README.md changed while the provider was running. Run the update again against the latest file.");
    }
    const currentHead = (await this.gitRunner(["rev-parse", "--verify", "HEAD"], repositoryRoot)).trim();
    if (currentHead !== headCommit) {
      throw new Error("HEAD changed while the provider was running. Run the README update again against the latest commit.");
    }
    const updatedAt = new Date().toISOString();
    await writeFile(readmePath, applyReadmeWatermark(result.content, { reviewedAt: updatedAt, commit: headCommit }), "utf8");
    return { ...request, ...result };
  }

  private async isAncestor(repositoryRoot: string, commit: string, headCommit: string): Promise<boolean> {
    try {
      await this.gitRunner(["merge-base", "--is-ancestor", commit, headCommit], repositoryRoot);
      return true;
    } catch {
      return false;
    }
  }
}

async function runGit(args: string[], cwd: string): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout;
}

export function parseReadmeWatermark(content: string | undefined): { reviewedAt: string; commit: string } | undefined {
  if (!content) return undefined;
  const matches = [...content.matchAll(WATERMARK_PATTERN)];
  if (matches.length !== 1) return undefined;
  if (!content.trimEnd().endsWith(matches[0][0].replace(/\r$/, ""))) return undefined;
  const reviewedAt = matches[0][1].trim();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(reviewedAt) || Number.isNaN(Date.parse(reviewedAt))) return undefined;
  return { reviewedAt, commit: matches[0][2] };
}

export function applyReadmeWatermark(
  content: string,
  watermark: { reviewedAt: string; commit: string },
): string {
  const withoutMarkers = content.replace(WATERMARK_LINE_PATTERN, "").trimEnd();
  return `${withoutMarkers}\n\n<!-- vibecheck-readme: reviewed-at=${watermark.reviewedAt}; commit=${watermark.commit} -->\n`;
}

export function codexReadmeArguments(
  request: ReadmeMaintenanceRequest,
  schemaPath: string,
  resultPath: string,
): string[] {
  return [
    "exec", "--model", request.model,
    "--config", `model_reasoning_effort=\"${request.effort}\"`,
    "--sandbox", "read-only", "--ephemeral",
    "--output-schema", schemaPath,
    "--output-last-message", resultPath,
    "--json", readmePrompt(request),
  ];
}

export function claudeReadmeArguments(request: ReadmeMaintenanceRequest): string[] {
  return [
    "--print", "--model", request.model, "--effort", request.effort,
    "--output-format", "stream-json", "--verbose",
    "--json-schema", JSON.stringify(README_SCHEMA),
    "--permission-mode", "dontAsk",
    "--allowed-tools", "Read,Grep,Glob,Bash(git status *),Bash(git diff *),Bash(git log *),Bash(git show *),Bash(git ls-files *)",
    "--no-session-persistence", readmePrompt(request),
  ];
}

export function readmePrompt(request: ReadmeMaintenanceRequest): string {
  const scope = request.mode === "incremental" && request.baseCommit
    ? [
        `README.md was last reviewed at commit ${request.baseCommit}.`,
        `Review committed changes through ${request.headCommit} with git log and git diff ${request.baseCommit}..${request.headCommit}, plus current working-tree and untracked changes.`,
        "Update the existing README holistically where those changes affect its accuracy; preserve still-correct content and structure.",
      ]
    : [
        "No valid VibeCheck README watermark is available, so review the whole repository.",
        "Inspect tracked and relevant untracked source, manifests, configuration, tests, documentation, and current README.md when present.",
        "Create or revise a holistic README based only on repository evidence.",
      ];
  return [
    ...scope,
    "Return the complete proposed root README.md as Markdown in the structured content field and a short summary of the documentation changes.",
    "The content field must contain only the raw README document with a Markdown H1: do not wrap it in a code fence, add a proposed-README heading, return a plan, mention a plan file, or include commentary outside the document.",
    "Make the README useful to developers and users: explain purpose, capabilities, setup, common workflows, configuration, architecture, testing, and constraints when repository evidence supports them.",
    "Do not invent behavior, commands, prerequisites, links, compatibility, or roadmap claims. Do not modify files or include a VibeCheck watermark; the extension adds the canonical marker after validation.",
  ].join(" ");
}

export function parseReadmeOutput(raw: string): ReadmeMaintenanceResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The README provider returned invalid JSON.");
  }
  if (isRecord(value) && isRecord(value.structured_output)) value = value.structured_output;
  if (!isRecord(value) || typeof value.summary !== "string" || typeof value.content !== "string") {
    throw new Error("The README provider returned an invalid structured response.");
  }
  const summary = value.summary.trim();
  const content = normalizeReadmeContent(value.content);
  if (!summary) throw new Error("The README provider returned an empty summary.");
  if (!content) throw new Error("The README provider returned empty README content.");
  if (!/^#\s+\S/m.test(content)) {
    throw new Error("The README provider did not return a complete Markdown document with an H1 heading.");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_README_BYTES) throw new Error("The proposed README exceeds the 2 MB limit.");
  if (content.includes("\0")) throw new Error("The proposed README contains invalid null bytes.");
  return { summary, content };
}

function normalizeReadmeContent(value: string): string {
  const content = value.trim();
  const bareFence = content.match(/^```(?:markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  if (bareFence) return bareFence[1].trim();

  const proposedFence = content.match(/^([^\n]{1,240})\r?\n+```(?:markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  if (proposedFence && /proposed\s+(?:root\s+)?(?:`?README(?:\.md)?`?|readme)/i.test(proposedFence[1])) {
    return proposedFence[2].trim();
  }
  return content;
}

async function runProvider(
  provider: CodeReviewSelection["provider"],
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  onProgress?: (progress: ReadmeProgress) => void,
  onTranscript?: (entry: Omit<CodeReviewTranscriptEntry, "at">) => void,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(provider, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const events: unknown[] = [];
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(events);
    };
    const consumeLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as unknown;
        events.push(event);
        normalizeReviewTranscriptEvent(provider, event).forEach((entry) => onTranscript?.(relabel(entry)));
        const progress = normalizeReadmeEvent(provider, event);
        if (progress) onProgress?.(progress);
      } catch { /* Provider diagnostics that are not JSON remain ephemeral. */ }
    };
    const abort = () => { child.kill(); finish(new Error("README update cancelled.")); };
    const timeout = setTimeout(() => { child.kill(); finish(new Error("README update timed out after 10 minutes.")); }, README_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      lines.forEach(consumeLine);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-MAX_OUTPUT_BYTES); });
    child.on("error", (error) => finish(error));
    child.on("close", (code, terminatedBySignal) => {
      consumeLine(stdoutBuffer);
      code === 0 ? finish() : finish(new Error(stderr.trim() || `${provider} exited with ${code ?? terminatedBySignal}.`));
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export function normalizeReadmeEvent(
  provider: CodeReviewSelection["provider"],
  value: unknown,
): ReadmeProgress | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (provider === "codex") {
    if (value.type === "thread.started") return { label: "Starting Codex" };
    if (value.type === "turn.started") return { label: "Reviewing README scope" };
    if (value.type === "turn.completed") return { label: "Validating README update" };
    if ((value.type === "item.started" || value.type === "item.completed") && isRecord(value.item)) {
      if (value.item.type === "command_execution") return { label: "Inspecting repository evidence" };
      if (value.item.type === "reasoning") return { label: "Drafting README content" };
    }
    return undefined;
  }
  if (value.type === "system" && value.subtype === "init") return { label: "Starting Claude" };
  if (value.type === "result") return { label: "Validating README update" };
  if (value.type !== "assistant" || !isRecord(value.message) || !Array.isArray(value.message.content)) return undefined;
  for (const block of value.message.content) {
    if (!isRecord(block) || block.type !== "tool_use" || typeof block.name !== "string") continue;
    if (["Read", "Grep", "Glob", "Bash"].includes(block.name)) return { label: "Inspecting repository evidence" };
  }
  return undefined;
}

function relabel(entry: Omit<CodeReviewTranscriptEntry, "at">): Omit<CodeReviewTranscriptEntry, "at"> {
  if (entry.label === "Review started") return { ...entry, label: "README review started" };
  if (entry.label === "Review failed") return { ...entry, label: "README review failed" };
  return entry;
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
