import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { ChangeSummaryRequest, ChangeSummaryResult } from "../domain/change-summary";

const SUMMARY_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    overview: { type: "string" },
    highlights: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          heading: { type: "string" },
          description: { type: "string" },
        },
        required: ["heading", "description"],
      },
    },
    impact: { type: ["string", "null"] },
    validation: { type: ["string", "null"] },
  },
  required: ["title", "overview", "highlights", "impact", "validation"],
} as const;

export class ChangeSummaryService {
  public async run(
    request: ChangeSummaryRequest,
    repositoryRoot: string,
    signal?: AbortSignal,
  ): Promise<ChangeSummaryResult> {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "vibecheck-summary-"));
    const schemaPath = path.join(temporaryDirectory, "schema.json");
    const resultPath = path.join(temporaryDirectory, "result.json");
    try {
      await writeFile(schemaPath, JSON.stringify(SUMMARY_SCHEMA), "utf8");
      const args = request.provider === "codex"
        ? codexSummaryArguments(request, schemaPath, resultPath)
        : claudeSummaryArguments(request);
      const events = await runProvider(request.provider, args, repositoryRoot, signal);
      if (request.provider === "codex") {
        return parseChangeSummaryOutput(await readFile(resultPath, "utf8"));
      }
      const result = [...events].reverse().find((event) => isRecord(event) && event.type === "result");
      if (!result) throw new Error("Claude completed without a structured result event.");
      return parseChangeSummaryOutput(JSON.stringify(result));
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

export function codexSummaryArguments(
  request: ChangeSummaryRequest,
  schemaPath: string,
  resultPath: string,
): string[] {
  return [
    "exec", "--model", request.model,
    "--config", `model_reasoning_effort=\"${request.effort}\"`,
    "--sandbox", "read-only", "--ephemeral",
    "--output-schema", schemaPath,
    "--output-last-message", resultPath,
    "--json", summaryPrompt(request),
  ];
}

export function claudeSummaryArguments(request: ChangeSummaryRequest): string[] {
  return [
    "--print", "--model", request.model, "--effort", request.effort,
    "--output-format", "stream-json", "--verbose",
    "--json-schema", JSON.stringify(SUMMARY_SCHEMA),
    "--permission-mode", "plan",
    "--allowed-tools", "Read,Grep,Glob,Bash(git diff *),Bash(git log *),Bash(git status *)",
    "--no-session-persistence", summaryPrompt(request),
  ];
}

function summaryPrompt(request: ChangeSummaryRequest): string {
  const scope = request.scope === "working-tree"
    ? [
        `Summarize the uncommitted working-tree changes relative to commit ${request.base}.`,
        `Inspect git status --short, git diff --no-ext-diff ${request.base} --, and the contents of untracked files reported by Git.`,
      ]
    : [
        `Summarize the repository changes between commits ${request.base} and ${request.target}.`,
        `Inspect them with git diff --no-ext-diff ${request.base}..${request.target} -- and relevant commit history.`,
      ];
  return [
    ...scope,
    "Write for a merge-review reader, product partner, or engineering stakeholder.",
    "Use plain human language focused on behavior, outcomes, and meaningful impact rather than implementation mechanics.",
    "Return a specific short title, a 1-2 sentence overview, and 1-6 distinct highlights with brief headings and one-sentence descriptions.",
    "Include impact only when users, operations, compatibility, or delivery are meaningfully affected.",
    "Include validation only when the diff or commit history provides concrete evidence; do not invent testing.",
    "Avoid file-by-file narration, code identifiers, line counts, conventional-commit prefixes, praise, and overly technical language.",
  ].join(" ");
}

export function parseChangeSummaryOutput(raw: string): ChangeSummaryResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The summary provider returned invalid JSON.");
  }
  if (isRecord(value) && isRecord(value.structured_output)) value = value.structured_output;
  if (!isRecord(value) || typeof value.title !== "string" || typeof value.overview !== "string" || !Array.isArray(value.highlights)) {
    throw new Error("The summary provider returned an invalid structured response.");
  }
  const highlights = value.highlights
    .filter(isChangeHighlight)
    .slice(0, 6)
    .map((item) => ({ heading: item.heading.trim(), description: item.description.trim() }))
    .filter((item) => item.heading && item.description);
  if (!highlights.length) throw new Error("The summary provider returned no change highlights.");
  return {
    title: value.title.trim() || "Change Summary",
    overview: value.overview.trim(),
    highlights,
    impact: optionalText(value.impact),
    validation: optionalText(value.validation),
  };
}

async function runProvider(
  command: "codex" | "claude",
  args: string[],
  cwd: string,
  signal?: AbortSignal,
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
      error ? reject(error) : resolve(events);
    };
    const consumeLine = (line: string) => {
      if (!line.trim()) return;
      try { events.push(JSON.parse(line) as unknown); } catch { /* Ignore provider diagnostics. */ }
    };
    const abort = () => { child.kill(); finish(new Error("Change summary cancelled.")); };
    const timeout = setTimeout(() => { child.kill(); finish(new Error("Change summary timed out after 10 minutes.")); }, SUMMARY_TIMEOUT_MS);
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
      code === 0 ? finish() : finish(new Error(stderr.trim() || `${command} exited with ${code ?? terminatedBySignal}.`));
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isChangeHighlight(value: unknown): value is { heading: string; description: string } {
  return isRecord(value) && typeof value.heading === "string" && typeof value.description === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
