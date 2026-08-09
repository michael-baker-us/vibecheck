import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

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
const MAX_FILE_BYTES = 256 * 1024;
const MAX_PROPOSAL_BYTES = 1024 * 1024;
const REQUIRED_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const FIXED_FILES = new Set<string>([
  ...REQUIRED_FILES,
  ".codex/config.toml",
  ".codex/hooks.json",
  ".mcp.json",
  ".codex-plugin/plugin.json",
  ".claude/settings.json",
  ".claude-plugin/plugin.json",
]);
const GENERATED_PATH_PATTERNS = [
  /^\.codex\/rules\/[a-z0-9][a-z0-9._-]*\.rules$/,
  /^\.codex\/agents\/[a-z0-9][a-z0-9._-]*\.toml$/,
  /^\.agents\/skills\/[a-z0-9][a-z0-9._-]*\/SKILL\.md$/,
  /^\.claude\/rules\/[a-z0-9][a-z0-9._-]*\.md$/,
  /^\.claude\/agents\/[a-z0-9][a-z0-9._-]*\.md$/,
  /^\.claude\/skills\/[a-z0-9][a-z0-9._-]*\/SKILL\.md$/,
  /^\.claude\/output-styles\/[a-z0-9][a-z0-9._-]*\.md$/,
] as const;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    files: {
      type: "array",
      minItems: 2,
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["path", "content", "rationale"],
      },
    },
  },
  required: ["summary", "files"],
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
    const parsed = parseInstructionRefreshOutput(await this.runner(
      selection,
      repositoryRoot,
      prompt,
      signal,
      onProgress,
      onTranscript,
    ));
    const files = await Promise.all(parsed.files.map(async (file): Promise<InstructionRefreshFileProposal> => {
      const originalContent = await readOptional(path.join(repositoryRoot, file.path));
      return {
        path: file.path,
        originalContent,
        proposedContent: file.content,
        rationale: file.rationale,
        status: originalContent === undefined ? "created" : originalContent === file.content ? "unchanged" : "modified",
      };
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
      await Promise.all(existing.map(async (file) => {
        const backupPath = path.join(backupDirectory!, file.path);
        await mkdir(path.dirname(backupPath), { recursive: true });
        await writeFile(backupPath, file.originalContent!, "utf8");
      }));
    }
    for (const file of changed) {
      const target = path.join(repositoryRoot, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.proposedContent, "utf8");
    }
    return { changedFiles: changed.map((file) => file.path), ...(backupDirectory ? { backupDirectory } : {}) };
  }
}

export function parseInstructionRefreshOutput(output: string): {
  summary: string;
  files: Array<{ path: InstructionFilePath; content: string; rationale: string }>;
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
    || !Array.isArray(value.files)
    || value.files.length < 2
    || value.files.length > 40) {
    throw new Error("The provider returned an invalid instruction proposal.");
  }
  const summary = value.summary.trim();
  const seen = new Set<string>();
  const files = value.files.map((candidate): { path: InstructionFilePath; content: string; rationale: string } => {
    if (!isRecord(candidate)
      || typeof candidate.path !== "string"
      || typeof candidate.content !== "string"
      || typeof candidate.rationale !== "string"
      || !isAllowedWorkspacePath(candidate.path)) {
      throw new Error("The provider proposed an unsupported Agent Workspace file.");
    }
    if (seen.has(candidate.path)) throw new Error(`The provider proposed ${candidate.path} more than once.`);
    seen.add(candidate.path);
    const content = normalizeFileContent(candidate.content, candidate.path);
    validateStructuredFile(candidate.path, content);
    const rationale = candidate.rationale.trim();
    if (!rationale) throw new Error(`The provider gave no rationale for ${candidate.path}.`);
    return { path: candidate.path, content, rationale };
  });
  for (const required of REQUIRED_FILES) {
    if (!seen.has(required)) throw new Error(`The provider proposal is missing required ${required}.`);
  }
  const claudeMarkdown = files.find((file) => file.path === "CLAUDE.md")!.content;
  if (!/^\uFEFF?[ \t]*@AGENTS\.md[ \t]*(?:\n|$)/.test(claudeMarkdown)) {
    throw new Error("The proposed CLAUDE.md does not begin by importing canonical @AGENTS.md guidance.");
  }
  validatePortableSkillPairs(files);
  const totalBytes = files.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0);
  if (totalBytes > MAX_PROPOSAL_BYTES) throw new Error("The Agent Workspace proposal is too large.");
  return { summary, files };
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
    const abort = () => { child.kill(); finish(new Error("Agent Workspace generation cancelled.")); };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("Agent Workspace generation timed out after 10 minutes."));
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
    if (value.type === "turn.started") return { label: "Scanning repository workspace needs" };
    if (value.type === "turn.completed") return { label: "Preparing Agent Workspace preview" };
    if ((value.type === "item.started" || value.type === "item.completed") && isRecord(value.item)) {
      if (value.item.type === "command_execution") return { label: "Inspecting repository evidence" };
      if (value.item.type === "reasoning") return { label: "Selecting evidence-backed workspace files" };
    }
    return undefined;
  }
  if (value.type === "system" && value.subtype === "init") return { label: "Starting Claude" };
  if (value.type === "result") return { label: "Preparing Agent Workspace preview" };
  if (value.type !== "assistant" || !isRecord(value.message) || !Array.isArray(value.message.content)) return undefined;
  for (const block of value.message.content) {
    if (!isRecord(block) || block.type !== "tool_use" || typeof block.name !== "string") continue;
    if (["Read", "Grep", "Glob", "Bash"].includes(block.name)) return { label: "Inspecting repository evidence" };
  }
  return undefined;
}

function normalizeFileContent(content: string, label: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trimEnd() + "\n";
  if (!normalized.trim()) throw new Error(`The proposed ${label} is empty.`);
  if (Buffer.byteLength(normalized, "utf8") > MAX_FILE_BYTES) throw new Error(`The proposed ${label} is too large.`);
  return normalized;
}

export function isAllowedWorkspacePath(value: string): value is InstructionFilePath {
  return FIXED_FILES.has(value) || GENERATED_PATH_PATTERNS.some((pattern) => pattern.test(value));
}

function validateStructuredFile(filePath: InstructionFilePath, content: string): void {
  if (filePath.endsWith(".json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`The proposed ${filePath} is not valid JSON.`);
    }
    if (!isRecord(parsed)) throw new Error(`The proposed ${filePath} must contain a JSON object.`);
    rejectEmbeddedSecrets(parsed, filePath);
  }
  if (filePath.endsWith(".toml")) {
    let parsed: unknown;
    try {
      parsed = parseToml(content);
    } catch {
      throw new Error(`The proposed ${filePath} is not valid TOML.`);
    }
    rejectEmbeddedSecrets(parsed, filePath);
  }
  if (filePath.endsWith("/SKILL.md")) {
    const frontmatter = markdownFrontmatter(content);
    if (typeof frontmatter?.name !== "string" || typeof frontmatter.description !== "string") {
      throw new Error(`The proposed ${filePath} must contain Agent Skills name and description frontmatter.`);
    }
  }
  if (filePath.startsWith(".claude/agents/")) {
    const frontmatter = markdownFrontmatter(content);
    if (typeof frontmatter?.name !== "string" || typeof frontmatter.description !== "string") {
      throw new Error(`The proposed ${filePath} must contain Claude agent name and description frontmatter.`);
    }
  }
  if (filePath.startsWith(".claude/output-styles/")) {
    const frontmatter = markdownFrontmatter(content);
    if (typeof frontmatter?.name !== "string" || typeof frontmatter.description !== "string") {
      throw new Error(`The proposed ${filePath} must contain output-style name and description frontmatter.`);
    }
  }
  if (filePath.startsWith(".codex/agents/")
    && (!/^name\s*=\s*".+"/m.test(content)
      || !/^description\s*=\s*".+"/m.test(content)
      || !/^developer_instructions\s*=/m.test(content))) {
    throw new Error(`The proposed ${filePath} is missing required Codex agent fields.`);
  }
  if (filePath.endsWith(".rules") && !/\bprefix_rule\s*\(/.test(content)) {
    throw new Error(`The proposed ${filePath} contains no Codex prefix_rule.`);
  }
}

function markdownFrontmatter(content: string): Record<string, unknown> | undefined {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
  if (!match) return undefined;
  try {
    const parsed = parseYaml(match[1]) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function validatePortableSkillPairs(
  files: Array<{ path: InstructionFilePath; content: string }>,
): void {
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  for (const file of files) {
    const match = /^(?:\.agents|\.claude)\/skills\/([^/]+)\/SKILL\.md$/.exec(file.path);
    if (!match) continue;
    const other = file.path.startsWith(".agents/")
      ? `.claude/skills/${match[1]}/SKILL.md`
      : `.agents/skills/${match[1]}/SKILL.md`;
    const otherContent = byPath.get(other as InstructionFilePath);
    if (otherContent === undefined) throw new Error(`Portable skill '${match[1]}' must be proposed for both Claude and Codex.`);
    if (otherContent !== file.content) throw new Error(`Portable skill '${match[1]}' must have identical Claude and Codex content.`);
  }
}

function rejectEmbeddedSecrets(value: unknown, filePath: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => rejectEmbeddedSecrets(entry, filePath));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string"
      && /(secret|token|password|api[_-]?key|authorization)/i.test(key)
      && entry.trim()
      && !/^\$\{?[A-Z][A-Z0-9_]*\}?$/.test(entry.trim())) {
      throw new Error(`The proposed ${filePath} appears to embed a credential in '${key}'. Use an environment-variable reference instead.`);
    }
    rejectEmbeddedSecrets(entry, filePath);
  }
}

function relabel(entry: Omit<CodeReviewTranscriptEntry, "at">): Omit<CodeReviewTranscriptEntry, "at"> {
  if (entry.label === "Review started") return { ...entry, label: "Agent Workspace scan started" };
  if (entry.label === "Review failed") return { ...entry, label: "Agent Workspace scan failed" };
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
