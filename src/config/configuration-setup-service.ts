import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

import { ConfigLoader } from "./config-loader";
import {
  AgentPermissionGrants,
  CLAUDE_EDITING_TOOLS,
  NO_AGENT_GRANTS,
  claudeTools,
} from "../providers/claude-cli";
import { CodeReviewSelection, CodeReviewTranscriptEntry } from "../domain/code-review";
import { ConfigurationSetupResult } from "../domain/configuration-setup";
import { normalizeReviewTranscriptEvent } from "../reviews/code-review-service";

const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const CONFIGURATION_FILES = [".vibecheck/config.yaml", ".vibecheck/rules.yaml"] as const;

export type ConfigurationSetupProgress = { label: string; detail?: string };
export type ConfigurationProviderRunner = (
  provider: CodeReviewSelection["provider"],
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  onProgress?: (progress: ConfigurationSetupProgress) => void,
  onTranscript?: (entry: Omit<CodeReviewTranscriptEntry, "at">) => void,
) => Promise<void>;

export class ConfigurationSetupService {
  public constructor(
    private readonly configLoader = new ConfigLoader(),
    private readonly runner: ConfigurationProviderRunner = runProvider,
    private readonly grants: () => AgentPermissionGrants = () => NO_AGENT_GRANTS,
  ) {}

  public async run(
    selection: CodeReviewSelection,
    repositoryRoot: string,
    prompt: string,
    signal?: AbortSignal,
    onProgress?: (progress: ConfigurationSetupProgress) => void,
    onTranscript?: (entry: Omit<CodeReviewTranscriptEntry, "at">) => void,
  ): Promise<ConfigurationSetupResult> {
    const before = await this.readConfigurationFiles(repositoryRoot);
    const alternateBefore = await this.readAlternateConfigurationFiles(repositoryRoot);
    const args = selection.provider === "codex"
      ? codexConfigurationSetupArguments(selection, prompt)
      : claudeConfigurationSetupArguments(selection, prompt, this.grants());
    await this.runner(selection.provider, args, repositoryRoot, signal, onProgress, onTranscript);

    const after = await this.readConfigurationFiles(repositoryRoot);
    const alternateAfter = await this.readAlternateConfigurationFiles(repositoryRoot);
    const misplacedFiles = [...alternateAfter]
      .filter(([file, content]) => alternateBefore.get(file) !== content)
      .map(([file]) => file);
    if (misplacedFiles.length) {
      throw new Error(`The provider wrote VibeCheck configuration outside .vibecheck/: ${misplacedFiles.join(", ")}.`);
    }
    if (after.get(CONFIGURATION_FILES[0]) === undefined) {
      throw new Error("The provider completed without creating .vibecheck/config.yaml.");
    }
    await this.configLoader.load(repositoryRoot);
    return {
      changedFiles: CONFIGURATION_FILES.filter((file) => before.get(file) !== after.get(file)),
    };
  }

  private async readConfigurationFiles(repositoryRoot: string): Promise<Map<string, string | undefined>> {
    return new Map(await Promise.all(CONFIGURATION_FILES.map(async (file) => {
      try {
        return [file, await readFile(path.join(repositoryRoot, file), "utf8")] as const;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [file, undefined] as const;
        throw error;
      }
    })));
  }

  private async readAlternateConfigurationFiles(repositoryRoot: string): Promise<Map<string, string>> {
    const entries = await readdir(repositoryRoot, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(".") && entry.name !== ".vibecheck")
      .flatMap((entry) => ["config.yaml", "rules.yaml"].map((name) => path.join(entry.name, name)));
    const files = await Promise.all(candidates.map(async (file) => {
      try {
        return [file, await readFile(path.join(repositoryRoot, file), "utf8")] as const;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    }));
    return new Map(files.filter((file): file is readonly [string, string] => file !== undefined));
  }
}

export function codexConfigurationSetupArguments(
  selection: CodeReviewSelection,
  prompt: string,
): string[] {
  return [
    "exec", "--model", selection.model,
    "--config", `model_reasoning_effort=\"${selection.effort}\"`,
    "--sandbox", "workspace-write", "--ephemeral", "--json", prompt,
  ];
}

export function claudeConfigurationSetupArguments(
  selection: CodeReviewSelection,
  prompt: string,
  grants: AgentPermissionGrants = NO_AGENT_GRANTS,
): string[] {
  return [
    "--print", "--model", selection.model, "--effort", selection.effort,
    "--output-format", "stream-json", "--verbose",
    "--permission-mode", "acceptEdits",
    "--allowed-tools", claudeTools(CLAUDE_EDITING_TOOLS, grants),
    "--no-session-persistence", prompt,
  ];
}

async function runProvider(
  provider: CodeReviewSelection["provider"],
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  onProgress?: (progress: ConfigurationSetupProgress) => void,
  onTranscript?: (entry: Omit<CodeReviewTranscriptEntry, "at">) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(provider, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve();
    };
    const consumeLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as unknown;
        normalizeReviewTranscriptEvent(provider, event).forEach((entry) => onTranscript?.(relabel(entry)));
        const progress = normalizeConfigurationSetupEvent(provider, event);
        if (progress) onProgress?.(progress);
      } catch { /* Provider diagnostics that are not JSON remain ephemeral. */ }
    };
    const abort = () => { child.kill(); finish(new Error("Configuration setup cancelled.")); };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("Configuration setup timed out after 10 minutes."));
    }, SETUP_TIMEOUT_MS);
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

export function normalizeConfigurationSetupEvent(
  provider: CodeReviewSelection["provider"],
  value: unknown,
): ConfigurationSetupProgress | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (provider === "codex") {
    if (value.type === "thread.started") return { label: "Starting Codex" };
    if (value.type === "turn.started") return { label: "Inspecting repository configuration" };
    if (value.type === "turn.completed") return { label: "Validating VibeCheck configuration" };
    if ((value.type === "item.started" || value.type === "item.completed") && isRecord(value.item)) {
      if (value.item.type === "command_execution") return { label: "Inspecting repository evidence" };
      if (value.item.type === "file_change") return { label: "Updating .vibecheck files" };
      if (value.item.type === "reasoning") return { label: "Choosing evidence-backed quality gates" };
    }
    return undefined;
  }
  if (value.type === "system" && value.subtype === "init") return { label: "Starting Claude" };
  if (value.type === "result") return { label: "Validating VibeCheck configuration" };
  if (value.type !== "assistant" || !isRecord(value.message) || !Array.isArray(value.message.content)) return undefined;
  for (const block of value.message.content) {
    if (!isRecord(block) || block.type !== "tool_use" || typeof block.name !== "string") continue;
    if (block.name === "Write" || block.name === "Edit") return { label: "Updating .vibecheck files" };
    if (block.name === "Read" || block.name === "Grep" || block.name === "Glob" || block.name === "Bash") {
      return { label: "Inspecting repository evidence" };
    }
  }
  return undefined;
}

function relabel(
  entry: Omit<CodeReviewTranscriptEntry, "at">,
): Omit<CodeReviewTranscriptEntry, "at"> {
  if (entry.label === "Review started") return { ...entry, label: "Configuration setup started" };
  if (entry.label === "Review failed") return { ...entry, label: "Configuration setup failed" };
  if (entry.label === "File change proposed") return { ...entry, label: "Configuration file change" };
  return entry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
