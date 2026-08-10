import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { parseDocument, YAMLSeq, isSeq } from "yaml";

import { GateRecommendation } from "../domain/configuration";
import {
  PACKAGE_MANAGERS,
  PackageManager,
  PackageManagerId,
  detectPackageManager,
  packageManager,
} from "./package-managers";

export type RecommendationPlan = {
  recommendation: GateRecommendation;
  manager: PackageManager;
  /** Exactly what will run, as it will run. Shown to the user before they approve anything. */
  argv: string[];
};

export type RecommendationOutcome = {
  installed: string[];
  gateName: string;
  output: string;
};

const INSTALL_TIMEOUT_MS = 300_000;

/**
 * Applies a recommended gate: install its dependencies, then add the gate to `.vibecheck/config.yaml`.
 *
 * The install runs as an argument vector with no shell, so a package name can never become a
 * command. The gate is only written after the install succeeds, which keeps the configuration
 * honest — VibeCheck never lists a gate the repository cannot actually run.
 */
export class RecommendationService {
  public constructor(
    private readonly runner: (argv: string[], cwd: string, signal?: AbortSignal) => Promise<{ exitCode: number; output: string }> = runInstall,
  ) {}

  /** Resolves what would run, without running it. */
  public async plan(repositoryRoot: string, recommendation: GateRecommendation): Promise<RecommendationPlan> {
    const manager = recommendation.manager
      ? packageManager(recommendation.manager as PackageManagerId)
      : await this.detect(repositoryRoot);
    if (!manager) {
      throw new Error(
        "No supported package manager was detected for this repository, so VibeCheck cannot install the dependency itself.",
      );
    }
    return { recommendation, manager, argv: manager.devInstall(recommendation.packages) };
  }

  public async apply(
    repositoryRoot: string,
    recommendation: GateRecommendation,
    signal?: AbortSignal,
  ): Promise<RecommendationOutcome> {
    const { manager, argv } = await this.plan(repositoryRoot, recommendation);
    const result = await this.runner(argv, repositoryRoot, signal);
    if (result.exitCode !== 0) {
      throw new Error(`${manager.label} could not install ${recommendation.packages.join(", ")}. ${lastLine(result.output)}`);
    }
    await this.addGate(repositoryRoot, recommendation);
    return { installed: recommendation.packages, gateName: recommendation.gate.name, output: result.output };
  }

  private async detect(repositoryRoot: string): Promise<PackageManager | undefined> {
    const present = new Set<string>();
    const candidates = new Set(PACKAGE_MANAGERS.flatMap((manager) => manager.markers));
    await Promise.all([...candidates].map(async (marker) => {
      try {
        await access(path.join(repositoryRoot, marker));
        present.add(marker);
      } catch {
        // absent
      }
    }));
    return detectPackageManager((marker) => present.has(marker));
  }

  /**
   * Appends the gate and drops the applied recommendation, editing the YAML document rather than
   * rewriting it so comments and formatting the user owns survive.
   */
  private async addGate(repositoryRoot: string, recommendation: GateRecommendation): Promise<void> {
    const configPath = path.join(repositoryRoot, ".vibecheck", "config.yaml");
    const document = parseDocument(await readFile(configPath, "utf8"));

    const gate = recommendation.gate;
    const entry: Record<string, unknown> = {
      name: gate.name,
      ...(gate.category ? { category: gate.category } : {}),
      required: gate.required,
      command: gate.command,
      ...(gate.format ? { format: gate.format } : {}),
      ...(gate.reportPath ? { report_path: gate.reportPath } : {}),
      invalidated_by: gate.invalidatedBy,
    };

    const verification = document.get("verification");
    if (isSeq(verification)) verification.add(document.createNode(entry));
    else document.set("verification", document.createNode([entry]));

    const recommendations = document.get("recommendations");
    if (isSeq(recommendations)) {
      const remaining = (recommendations as YAMLSeq).items.filter((item) => {
        const value = (item as { toJSON?: () => unknown })?.toJSON?.() as { gate?: { name?: string } } | undefined;
        return value?.gate?.name !== gate.name;
      });
      if (remaining.length) (recommendations as YAMLSeq).items = remaining;
      else document.delete("recommendations");
    }

    await writeFile(configPath, document.toString(), "utf8");
  }
}

function runInstall(argv: string[], cwd: string, signal?: AbortSignal): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const [command, ...args] = argv;
    // No shell: argv elements are passed through verbatim and can never be reinterpreted.
    const child = spawn(command as string, args, { cwd, env: process.env });
    let output = "";
    const append = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-100_000); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => child.kill("SIGTERM"), INSTALL_TIMEOUT_MS);
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    const finish = (exitCode: number) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({ exitCode, output });
    };
    child.on("error", () => finish(1));
    child.on("close", (code) => finish(code ?? 1));
  });
}

function lastLine(output: string): string {
  return output.trim().split("\n").filter(Boolean).at(-1) ?? "";
}
