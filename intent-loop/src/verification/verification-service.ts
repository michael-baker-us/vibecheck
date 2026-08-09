import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { minimatch } from "minimatch";

import { GitCollector } from "../collectors/git-collector";
import { VerificationDefinition } from "../domain/configuration";
import { VerificationState } from "../domain/verification";

const MAX_OUTPUT_CHARACTERS = 200_000;

export class VerificationService {
  public constructor(private readonly git: GitCollector) {}

  public alignDefinitions(
    definitions: VerificationDefinition[],
    existing: VerificationState[],
  ): VerificationState[] {
    return definitions.map((definition) => {
      const previous = existing.find(
        (item) =>
          item.name === definition.name &&
          item.command === definition.command &&
          this.arraysEqual(item.invalidatedBy, definition.invalidatedBy),
      );
      return previous ?? {
        name: definition.name,
        command: definition.command,
        invalidatedBy: definition.invalidatedBy,
        status: "not-run",
      };
    });
  }

  public async refreshFreshness(
    repositoryRoot: string,
    states: VerificationState[],
  ): Promise<VerificationState[]> {
    return Promise.all(
      states.map(async (state) => {
        if (!state.inputHashes || (state.status !== "passed" && state.status !== "stale")) {
          return state;
        }
        const current = await this.hashInputs(repositoryRoot, state.invalidatedBy);
        return { ...state, status: this.recordsEqual(current, state.inputHashes) ? "passed" : "stale" };
      }),
    );
  }

  public async run(
    repositoryRoot: string,
    definition: VerificationDefinition,
    signal?: AbortSignal,
    onStarted?: (state: VerificationState) => void,
  ): Promise<VerificationState> {
    const startedAt = new Date();
    const running: VerificationState = {
      ...definition,
      status: "running",
      startedAt: startedAt.toISOString(),
    };
    onStarted?.(running);

    const inputHashes = await this.hashInputs(repositoryRoot, definition.invalidatedBy);
    const result = await this.execute(definition.command, repositoryRoot, signal);
    const finishedAt = new Date();
    return {
      ...running,
      status: result.exitCode === 0 ? "passed" : "failed",
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      exitCode: result.exitCode,
      output: this.redact(result.output).slice(-MAX_OUTPUT_CHARACTERS),
      inputHashes,
    };
  }

  public commandHash(repositoryRoot: string, command: string): string {
    return createHash("sha256").update(`${repositoryRoot}\0${command}`).digest("hex");
  }

  private async hashInputs(repositoryRoot: string, patterns: string[]): Promise<Record<string, string>> {
    const files = await this.git.listRepositoryFiles(repositoryRoot);
    const matched = files.filter((file) => patterns.some((pattern) => minimatch(file, pattern, { dot: true })));
    const entries = await Promise.all(
      matched.map(async (relativePath): Promise<[string, string] | undefined> => {
        try {
          const content = await readFile(path.join(repositoryRoot, relativePath));
          return [relativePath, createHash("sha256").update(content).digest("hex")];
        } catch {
          return undefined;
        }
      }),
    );
    return Object.fromEntries(entries.filter((entry): entry is [string, string] => entry !== undefined));
  }

  private execute(
    command: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number; output: string }> {
    return new Promise((resolve) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        env: process.env,
      });
      let output = "";
      const append = (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-MAX_OUTPUT_CHARACTERS * 2);
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);

      const abort = () => child.kill("SIGTERM");
      signal?.addEventListener("abort", abort, { once: true });
      child.on("error", (error) => {
        signal?.removeEventListener("abort", abort);
        resolve({ exitCode: 1, output: `${output}\n${error.message}` });
      });
      child.on("close", (code, terminatedBy) => {
        signal?.removeEventListener("abort", abort);
        const suffix = terminatedBy ? `\nTerminated by ${terminatedBy}.` : "";
        resolve({ exitCode: code ?? 1, output: output + suffix });
      });
    });
  }

  private redact(output: string): string {
    return output.replace(
      /\b(api[_-]?key|access[_-]?token|token|password|secret)\b\s*[:=]\s*[^\s]+/gi,
      "$1=[REDACTED]",
    );
  }

  private recordsEqual(left: Record<string, string>, right: Record<string, string>): boolean {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return this.arraysEqual(leftKeys, rightKeys) && leftKeys.every((key) => left[key] === right[key]);
  }

  private arraysEqual(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
}
