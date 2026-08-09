import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  CodeReviewFinding,
  CodeReviewProvider,
  CodeReviewResult,
  CodeReviewSelection,
  CodeReviewTranscriptEntry,
} from "../domain/code-review";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const REVIEW_TIMEOUT_MS = 10 * 60 * 1000;

export type ReviewProgress = { label: string; detail?: string };

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          explanation: { type: "string" },
          severity: { type: "string", enum: ["info", "medium", "high"] },
          path: { type: ["string", "null"] },
          line: { type: ["integer", "null"], minimum: 1 },
          endLine: { type: ["integer", "null"], minimum: 1 },
        },
        required: ["title", "explanation", "severity", "path", "line", "endLine"],
      },
    },
  },
  required: ["summary", "findings"],
} as const;

const REVIEW_PROMPT = [
  "Review the uncommitted working-tree changes against HEAD.",
  "Report at most 10 concrete, actionable defects introduced by the diff; omit pre-existing problems.",
  "Use high only for security, data loss, crashes, or broadly broken behavior; medium for reproducible functional defects; info for bounded maintainability risks with a concrete future cost.",
  "Keep the summary to 3 sentences and each explanation to 3 sentences covering the defect, impact, and trigger.",
  "Do not modify files. Avoid style preferences, praise, speculation, and duplicate findings. Use repository-relative paths and changed-line numbers.",
  "Return an empty findings array when no defects are found.",
].join(" ");

export class CodeReviewService {
  public async run(
    selection: CodeReviewSelection,
    repositoryRoot: string,
    signal?: AbortSignal,
    onProgress?: (progress: ReviewProgress) => void,
    onTranscript?: (entry: Omit<CodeReviewTranscriptEntry, "at">) => void,
  ): Promise<CodeReviewResult> {
    return selection.provider === "codex"
      ? this.runCodex(selection, repositoryRoot, signal, onProgress, onTranscript)
      : this.runClaude(selection, repositoryRoot, signal, onProgress, onTranscript);
  }

  private async runCodex(
    selection: CodeReviewSelection,
    repositoryRoot: string,
    signal?: AbortSignal,
    onProgress?: (progress: ReviewProgress) => void,
    onTranscript?: (entry: Omit<CodeReviewTranscriptEntry, "at">) => void,
  ): Promise<CodeReviewResult> {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "vibecheck-review-"));
    const schemaPath = path.join(temporaryDirectory, "schema.json");
    const resultPath = path.join(temporaryDirectory, "result.json");
    try {
      await writeFile(schemaPath, JSON.stringify(REVIEW_SCHEMA), "utf8");
      await this.runStreaming(
        "codex",
        codexReviewArguments(selection, schemaPath, resultPath),
        repositoryRoot,
        "codex",
        signal,
        onProgress,
        onTranscript,
      );
      return parseCodeReviewOutput(await readFile(resultPath, "utf8"));
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private async runClaude(
    selection: CodeReviewSelection,
    repositoryRoot: string,
    signal?: AbortSignal,
    onProgress?: (progress: ReviewProgress) => void,
    onTranscript?: (entry: Omit<CodeReviewTranscriptEntry, "at">) => void,
  ): Promise<CodeReviewResult> {
    const events = await this.runStreaming(
      "claude",
      claudeReviewArguments(selection),
      repositoryRoot,
      "claude",
      signal,
      onProgress,
      onTranscript,
    );
    const result = [...events].reverse().find((event) => isRecord(event) && event.type === "result");
    if (!result) throw new Error("Claude completed without a structured result event.");
    return parseCodeReviewOutput(JSON.stringify(result));
  }

  private async runStreaming(
    command: string,
    args: string[],
    cwd: string,
    provider: CodeReviewProvider,
    signal?: AbortSignal,
    onProgress?: (progress: ReviewProgress) => void,
    onTranscript?: (entry: Omit<CodeReviewTranscriptEntry, "at">) => void,
  ): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      const events: unknown[] = [];
      let stdoutBuffer = "";
      let stderr = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(events);
      };
      const consumeLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line) as unknown;
          events.push(event);
          const progress = normalizeReviewEvent(provider, event);
          if (progress) onProgress?.(progress);
          normalizeReviewTranscriptEvent(provider, event).forEach((entry) => onTranscript?.(entry));
        } catch {
          // Provider diagnostics that are not JSON are intentionally not persisted.
        }
      };
      const abort = () => {
        child.kill();
        finish(new Error("Code review cancelled."));
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish(new Error("Code review timed out after 10 minutes."));
      }, REVIEW_TIMEOUT_MS);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        lines.forEach(consumeLine);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-MAX_OUTPUT_BYTES);
      });
      child.on("error", (error) => finish(error));
      child.on("close", (code, terminatedBySignal) => {
        consumeLine(stdoutBuffer);
        if (code === 0) finish();
        else finish(new Error(stderr.trim() || `${command} exited with ${code ?? terminatedBySignal}.`));
      });
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

export function codexReviewArguments(
  selection: CodeReviewSelection,
  schemaPath: string,
  resultPath: string,
): string[] {
  return [
    "exec",
    "--model",
    selection.model,
    "--config",
    `model_reasoning_effort=\"${selection.effort}\"`,
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    resultPath,
    "--json",
    REVIEW_PROMPT,
  ];
}

export function claudeReviewArguments(selection: CodeReviewSelection): string[] {
  return [
    "--print",
    "--model",
    selection.model,
    "--effort",
    selection.effort,
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    JSON.stringify(REVIEW_SCHEMA),
    "--permission-mode",
    "plan",
    "--allowed-tools",
    "Read,Grep,Glob,Bash(git diff *),Bash(git status *)",
    "--no-session-persistence",
    REVIEW_PROMPT,
  ];
}

export function normalizeReviewTranscriptEvent(
  provider: CodeReviewProvider,
  value: unknown,
): Array<Omit<CodeReviewTranscriptEntry, "at">> {
  if (!isRecord(value) || typeof value.type !== "string") return [];
  if (provider === "codex") return codexTranscript(value);
  return claudeTranscript(value);
}

function codexTranscript(value: Record<string, unknown>): Array<Omit<CodeReviewTranscriptEntry, "at">> {
  if (value.type === "thread.started") return [{ kind: "status", label: "Codex session started" }];
  if (value.type === "turn.started") return [{ kind: "status", label: "Review started" }];
  if (value.type === "turn.failed") {
    const error = isRecord(value.error) && typeof value.error.message === "string" ? value.error.message : "Review failed";
    return [{ kind: "error", label: "Codex error", content: boundedText(error) }];
  }
  if (value.type !== "item.started" && value.type !== "item.completed") return [];
  if (!isRecord(value.item) || typeof value.item.type !== "string") return [];
  const item = value.item;
  if (item.type === "agent_message" && typeof item.text === "string") {
    return [{ kind: "assistant", label: "Codex", content: boundedText(item.text) }];
  }
  if (item.type === "command_execution") {
    const entries: Array<Omit<CodeReviewTranscriptEntry, "at">> = [];
    if (value.type === "item.started" && typeof item.command === "string") {
      entries.push({ kind: "tool", label: "Command", content: boundedText(item.command) });
    }
    if (value.type === "item.completed" && typeof item.aggregated_output === "string" && item.aggregated_output.trim()) {
      entries.push({ kind: "output", label: `Command output${typeof item.exit_code === "number" ? ` · exit ${item.exit_code}` : ""}`, content: boundedText(item.aggregated_output) });
    }
    return entries;
  }
  if (item.type === "mcp_tool_call") {
    const name = [item.server, item.tool].filter((part) => typeof part === "string").join("/") || "MCP tool";
    if (value.type === "item.started") return [{ kind: "tool", label: name, content: boundedJson(item.arguments) }];
    if (item.error) return [{ kind: "error", label: `${name} failed`, content: boundedJson(item.error) }];
    return item.result ? [{ kind: "output", label: `${name} result`, content: boundedJson(item.result) }] : [];
  }
  if (item.type === "file_change") {
    return [{ kind: "tool", label: "File change proposed", content: boundedJson(item.changes) }];
  }
  return [];
}

function claudeTranscript(value: Record<string, unknown>): Array<Omit<CodeReviewTranscriptEntry, "at">> {
  if (value.type === "system" && value.subtype === "init") {
    const detail = [
      typeof value.model === "string" ? `Model: ${value.model}` : undefined,
      typeof value.permissionMode === "string" ? `Permissions: ${value.permissionMode}` : undefined,
    ].filter(Boolean).join(" · ");
    return [{ kind: "status", label: "Claude session started", content: detail || undefined }];
  }
  if (value.type === "system" && value.subtype === "hook_started") {
    const hook = typeof value.hook_name === "string" ? value.hook_name
      : typeof value.hook_event === "string" ? value.hook_event : "Claude hook";
    return [{ kind: "tool", label: `Hook · ${hook}` }];
  }
  if (value.type === "system" && value.subtype === "status" && typeof value.status === "string") {
    return [{ kind: "status", label: value.status }];
  }
  if (value.type === "result" && value.subtype !== "success") {
    return [{ kind: "error", label: "Claude result", content: boundedText(value.result) }];
  }
  if ((value.type !== "assistant" && value.type !== "user") || !isRecord(value.message) || !Array.isArray(value.message.content)) {
    return [];
  }
  const entries: Array<Omit<CodeReviewTranscriptEntry, "at">> = [];
  for (const block of value.message.content) {
    if (!isRecord(block) || typeof block.type !== "string") continue;
    if (value.type === "assistant" && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      entries.push({ kind: "assistant", label: "Claude", content: boundedText(block.text) });
    }
    if (value.type === "assistant" && block.type === "tool_use") {
      entries.push({ kind: "tool", label: typeof block.name === "string" ? block.name : "Tool", content: boundedJson(block.input) });
    }
    if (value.type === "user" && block.type === "tool_result") {
      entries.push({
        kind: block.is_error === true ? "error" : "output",
        label: block.is_error === true ? "Tool error" : "Tool result",
        content: boundedContent(block.content),
      });
    }
  }
  return entries;
}

function boundedContent(value: unknown): string | undefined {
  if (typeof value === "string") return boundedText(value);
  if (Array.isArray(value)) {
    const text = value.flatMap((item) => isRecord(item) && typeof item.text === "string" ? [item.text] : []).join("\n");
    if (text) return boundedText(text);
  }
  return boundedJson(value);
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replaceAll("\r\n", "\n").trim();
  if (!normalized) return undefined;
  return normalized.length > 4_000 ? `${normalized.slice(0, 4_000)}\n… output truncated …` : normalized;
}

function boundedJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return boundedText(JSON.stringify(value, null, 2));
  } catch {
    return undefined;
  }
}

export function normalizeReviewEvent(
  provider: CodeReviewProvider,
  value: unknown,
): ReviewProgress | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (provider === "codex") {
    if (value.type === "thread.started") return { label: "Starting Codex review" };
    if (value.type === "turn.started") return { label: "Analyzing uncommitted changes" };
    if (value.type === "turn.completed") return { label: "Formatting review findings" };
    if ((value.type === "item.started" || value.type === "item.completed") && isRecord(value.item)) {
      if (value.item.type === "command_execution") return { label: "Inspecting repository evidence" };
      if (value.item.type === "reasoning") return { label: "Evaluating potential defects" };
      if (value.item.type === "agent_message") return { label: "Drafting concise findings" };
    }
    return undefined;
  }
  if (value.type === "system" && value.subtype === "init") return { label: "Starting Claude review" };
  if (value.type === "system" && value.subtype === "thinking_tokens") return { label: "Analyzing changes" };
  if (value.type === "result") return { label: "Formatting review findings" };
  if (value.type !== "assistant" || !isRecord(value.message) || !Array.isArray(value.message.content)) {
    return undefined;
  }
  for (const block of value.message.content) {
    if (!isRecord(block) || block.type !== "tool_use" || typeof block.name !== "string") continue;
    const input = isRecord(block.input) ? block.input : {};
    if (block.name === "Read") return { label: "Reading changed code", detail: compactPath(input.file_path) };
    if (block.name === "Grep") return { label: "Searching repository context" };
    if (block.name === "Glob") return { label: "Discovering related files" };
    if (block.name === "Bash") return { label: "Inspecting working-tree diff" };
  }
  return undefined;
}

function compactPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replaceAll("\\", "/").split("/").filter(Boolean).slice(-3).join("/").slice(0, 160) || undefined;
}

export function parseCodeReviewOutput(output: string): CodeReviewResult {
  const parsed = JSON.parse(output) as unknown;
  const candidate = unwrapResult(parsed);
  if (!isRecord(candidate) || typeof candidate.summary !== "string" || !Array.isArray(candidate.findings)) {
    throw new Error("Review provider returned an invalid structured response.");
  }
  const findings = candidate.findings.map(parseFinding);
  return { summary: candidate.summary.slice(0, 4000), findings };
}

function unwrapResult(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (isRecord(value.structured_output)) return value.structured_output;
  if (isRecord(value.result)) return value.result;
  if (typeof value.result === "string") return JSON.parse(value.result);
  return value;
}

function parseFinding(value: unknown, index: number): CodeReviewFinding {
  if (!isRecord(value) || typeof value.title !== "string" || typeof value.explanation !== "string") {
    throw new Error(`Review provider returned an invalid finding at index ${index}.`);
  }
  const severity = value.severity === "high" || value.severity === "medium" ? value.severity : "info";
  const relativePath = typeof value.path === "string" && !path.isAbsolute(value.path)
    && !value.path.split(/[\\/]/).includes("..") ? value.path : undefined;
  const line = positiveInteger(value.line);
  const endLine = positiveInteger(value.endLine);
  const fingerprint = [value.title, value.explanation, relativePath ?? "", line ?? ""].join("\0");
  return {
    id: createHash("sha256").update(fingerprint).digest("hex").slice(0, 16),
    title: value.title.slice(0, 300),
    explanation: value.explanation.slice(0, 4000),
    severity,
    path: relativePath,
    line,
    endLine: endLine && line ? Math.max(line, endLine) : endLine,
  };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
