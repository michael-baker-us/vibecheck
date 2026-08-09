import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { CodeReviewSelection, CodeReviewTranscriptEntry } from "../domain/code-review";
import {
  InstructionFilePath,
  InstructionRefreshApplyResult,
  InstructionRefreshFileProposal,
  InstructionRefreshProposal,
} from "../domain/instruction-refresh";
import { normalizeReviewTranscriptEvent } from "../reviews/code-review-service";

const TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_INSTRUCTION_BYTES = 256 * 1024;
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    agentsMarkdown: { type: "string" },
    claudeMarkdown: { type: "string" },
  },
  required: ["summary", "agentsMarkdown", "claudeMarkdown"],
} as const;

export type InstructionRefreshProgress = { label: string; detail?: string };
export type InstructionRefreshRunner = (
  selection: CodeReviewSelection,
  repositoryRoot: string,
  prompt: string,
  signal?: AbortSignal,
  onProgress?: (progress: InstructionRefreshProgress) => void,
  onTranscript?: (entry: Omit<CodeReviewTranscriptEntry, "at">) => void,
) => Promise<string>;

export class InstructionRefreshService {
  public constructor(private readonly runner: InstructionRefreshRunner = runProvider) {}

  public async propose(
    selection: CodeReviewSelection,
    repositoryRoot: string,
    prompt: string,
    signal?: AbortSignal,
    onProgress?: (progress: InstructionRefreshProgress) => void,
    onTranscript?: (entry: Omit<CodeReviewTranscriptEntry, "at">) => void,
  ): Promise<InstructionRefreshProposal> {
    const originals = await Promise.all(INSTRUCTION_FILES.map((file) => readOptional(path.join(repositoryRoot, file))));
    const parsed = parseInstructionRefreshOutput(await this.runner(
      selection,
      repositoryRoot,
      prompt,
      signal,
      onProgress,
      onTranscript,
    ));
    const proposed = [parsed.agentsMarkdown, parsed.claudeMarkdown];
    const files = INSTRUCTION_FILES.map((file, index): InstructionRefreshFileProposal => ({
      path: file,
      originalContent: originals[index],
      proposedContent: proposed[index],
      status: originals[index] === undefined ? "created" : originals[index] === proposed[index] ? "unchanged" : "modified",
    }));
    return { summary: parsed.summary, files };
  }

  public async apply(
    repositoryRoot: string,
    proposal: InstructionRefreshProposal,
    backupRoot: string,
  ): Promise<InstructionRefreshApplyResult> {
    const changed = proposal.files.filter((file) => file.status !== "unchanged");
    for (const file of changed) {
      const current = await readOptional(path.join(repositoryRoot, file.path));
      if (current !== file.originalContent) {
        throw new Error(`${file.path} changed after the preview was generated. Generate a new preview before applying.`);
      }
    }
    let backupDirectory: string | undefined;
    const existing = changed.filter((file) => file.originalContent !== undefined);
    if (existing.length) {
      backupDirectory = path.join(backupRoot, String(Date.now()));
      await mkdir(backupDirectory, { recursive: true });
      await Promise.all(existing.map((file) => writeFile(path.join(backupDirectory!, file.path), file.originalContent!, "utf8")));
    }
    for (const file of changed) await writeFile(path.join(repositoryRoot, file.path), file.proposedContent, "utf8");
    return { changedFiles: changed.map((file) => file.path), ...(backupDirectory ? { backupDirectory } : {}) };
  }
}

export function parseInstructionRefreshOutput(output: string): {
  summary: string;
  agentsMarkdown: string;
  claudeMarkdown: string;
} {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("The provider returned invalid structured instruction output.");
  }
  if (isRecord(value) && isRecord(value.structured_output)) value = value.structured_output;
  if (!isRecord(value)
    || typeof value.summary !== "string"
    || typeof value.agentsMarkdown !== "string"
    || typeof value.claudeMarkdown !== "string") {
    throw new Error("The provider returned an invalid instruction proposal.");
  }
  const summary = value.summary.trim();
  const agentsMarkdown = normalizeMarkdown(value.agentsMarkdown, "AGENTS.md");
  const claudeMarkdown = normalizeMarkdown(value.claudeMarkdown, "CLAUDE.md");
  if (!/^\uFEFF?[ \t]*@AGENTS\.md[ \t]*(?:\n|$)/.test(claudeMarkdown)) {
    throw new Error("The proposed CLAUDE.md does not begin by importing canonical @AGENTS.md guidance.");
  }
  return { summary, agentsMarkdown, claudeMarkdown };
}

export function codexInstructionRefreshArguments(
  selection: CodeReviewSelection,
  schemaPath: string,
  resultPath: string,
  prompt: string,
): string[] {
  return [
    "exec", "--model", selection.model,
    "--config", `model_reasoning_effort=\"${selection.effort}\"`,
    "--sandbox", "read-only", "--ephemeral",
    "--output-schema", schemaPath, "--output-last-message", resultPath,
    "--json", prompt,
  ];
}

export function claudeInstructionRefreshArguments(selection: CodeReviewSelection, prompt: string): string[] {
  return [
    "--print", "--model", selection.model, "--effort", selection.effort,
    "--output-format", "stream-json", "--verbose",
    "--json-schema", JSON.stringify(RESPONSE_SCHEMA),
    "--permission-mode", "plan",
    "--allowed-tools", "Read,Grep,Glob,Bash(git status *),Bash(git diff *),Bash(git ls-files *),Bash(npm run *),Bash(yarn *),Bash(pnpm *),Bash(bun run *)",
    "--no-session-persistence", prompt,
  ];
}

async function runProvider(
  selection: CodeReviewSelection,
  repositoryRoot: string,
  prompt: string,
  signal?: AbortSignal,
  onProgress?: (progress: InstructionRefreshProgress) => void,
  onTranscript?: (entry: Omit<CodeReviewTranscriptEntry, "at">) => void,
): Promise<string> {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "vibecheck-instructions-"));
  try {
    const schemaPath = path.join(temporaryDirectory, "schema.json");
    const resultPath = path.join(temporaryDirectory, "result.json");
    await writeFile(schemaPath, JSON.stringify(RESPONSE_SCHEMA), "utf8");
    const events = await runStreaming(
      selection.provider,
      selection.provider === "codex"
        ? codexInstructionRefreshArguments(selection, schemaPath, resultPath, prompt)
        : claudeInstructionRefreshArguments(selection, prompt),
      repositoryRoot,
      signal,
      onProgress,
      onTranscript,
    );
    if (selection.provider === "codex") return readFile(resultPath, "utf8");
    const result = [...events].reverse().find((event) => isRecord(event) && event.type === "result");
    if (!result) throw new Error("Claude completed without a structured instruction proposal.");
    return JSON.stringify(result);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function runStreaming(
  provider: CodeReviewSelection["provider"],
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  onProgress?: (progress: InstructionRefreshProgress) => void,
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
        const progress = normalizeInstructionRefreshEvent(provider, event);
        if (progress) onProgress?.(progress);
      } catch { /* Non-JSON provider diagnostics remain ephemeral. */ }
    };
    const abort = () => { child.kill(); finish(new Error("Instruction refresh cancelled.")); };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("Instruction refresh timed out after 10 minutes."));
    }, TIMEOUT_MS);
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

export function normalizeInstructionRefreshEvent(
  provider: CodeReviewSelection["provider"],
  value: unknown,
): InstructionRefreshProgress | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (provider === "codex") {
    if (value.type === "thread.started") return { label: "Starting Codex" };
    if (value.type === "turn.started") return { label: "Auditing repository guidance" };
    if (value.type === "turn.completed") return { label: "Preparing instruction preview" };
    if ((value.type === "item.started" || value.type === "item.completed") && isRecord(value.item)) {
      if (value.item.type === "command_execution") return { label: "Inspecting repository evidence" };
      if (value.item.type === "reasoning") return { label: "Evaluating current instructions" };
    }
    return undefined;
  }
  if (value.type === "system" && value.subtype === "init") return { label: "Starting Claude" };
  if (value.type === "result") return { label: "Preparing instruction preview" };
  if (value.type !== "assistant" || !isRecord(value.message) || !Array.isArray(value.message.content)) return undefined;
  for (const block of value.message.content) {
    if (!isRecord(block) || block.type !== "tool_use" || typeof block.name !== "string") continue;
    if (["Read", "Grep", "Glob", "Bash"].includes(block.name)) return { label: "Inspecting repository evidence" };
  }
  return undefined;
}

function normalizeMarkdown(content: string, label: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trimEnd() + "\n";
  if (!normalized.trim()) throw new Error(`The proposed ${label} is empty.`);
  if (Buffer.byteLength(normalized, "utf8") > MAX_INSTRUCTION_BYTES) throw new Error(`The proposed ${label} is too large.`);
  return normalized;
}

function relabel(entry: Omit<CodeReviewTranscriptEntry, "at">): Omit<CodeReviewTranscriptEntry, "at"> {
  if (entry.label === "Review started") return { ...entry, label: "Instruction audit started" };
  if (entry.label === "Review failed") return { ...entry, label: "Instruction audit failed" };
  return entry;
}

async function readOptional(filePath: string): Promise<string | undefined> {
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
