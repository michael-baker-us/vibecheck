import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import { minimatch } from "minimatch";

import { GitCollector } from "./git-collector";
import { PlanConfiguration } from "../domain/configuration";
import { PlanDocument, PlanTask, PlanTaskStatus } from "../domain/plans";

const MAX_PLAN_BYTES = 512 * 1024;

export class PlanCollector {
  public constructor(private readonly git: GitCollector) {}

  public async collect(
    repositoryRoot: string,
    configuration: PlanConfiguration,
    selectedPath?: string,
  ): Promise<PlanDocument[]> {
    const files = await this.git.listRepositoryFiles(repositoryRoot);
    const candidates = files.filter((file) =>
      configuration.include.some((pattern) => minimatch(file, pattern, { dot: true, nocase: true })),
    );
    for (const discovered of await this.claudeProjectPlans(repositoryRoot)) {
      if (!candidates.includes(discovered)) candidates.push(discovered);
    }
    for (const explicit of [configuration.active, selectedPath]) {
      if (explicit && !candidates.includes(explicit)) candidates.push(explicit);
    }
    const plans = await Promise.all(candidates.map((file) => this.read(repositoryRoot, file)));
    return plans
      .filter((plan): plan is PlanDocument => plan !== undefined)
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  }

  public choose(
    plans: PlanDocument[],
    configuration: PlanConfiguration,
    selectedPath?: string,
  ): PlanDocument | undefined {
    const requested = selectedPath ?? configuration.active;
    if (requested) {
      const selected = plans.find((plan) => plan.path === requested);
      if (selected) return selected;
    }
    return plans[0];
  }

  private async read(repositoryRoot: string, relativePath: string): Promise<PlanDocument | undefined> {
    const absolutePath = path.resolve(repositoryRoot, relativePath);
    const relative = path.relative(repositoryRoot, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    try {
      const metadata = await stat(absolutePath);
      if (!metadata.isFile() || metadata.size > MAX_PLAN_BYTES) return undefined;
      const content = await readFile(absolutePath, "utf8");
      return parseMarkdownPlan(relativePath, content, metadata.mtime.toISOString());
    } catch {
      return undefined;
    }
  }

  private async claudeProjectPlans(repositoryRoot: string): Promise<string[]> {
    const settingsFiles = [
      path.join(repositoryRoot, ".claude", "settings.json"),
      path.join(repositoryRoot, ".claude", "settings.local.json"),
      path.join(homedir(), ".claude", "settings.json"),
    ];
    const directories = new Set<string>();
    for (const settingsFile of settingsFiles) {
      try {
        const settings = JSON.parse(await readFile(settingsFile, "utf8")) as { plansDirectory?: unknown };
        if (typeof settings.plansDirectory !== "string" || !settings.plansDirectory.trim()) continue;
        const absolute = path.resolve(repositoryRoot, settings.plansDirectory);
        const relative = path.relative(repositoryRoot, absolute);
        if (!relative.startsWith("..") && !path.isAbsolute(relative)) directories.add(absolute);
      } catch {
        // Missing or invalid agent settings do not prevent ordinary repository plan discovery.
      }
    }
    const discovered = await Promise.all([...directories].map((directory) => this.walkMarkdown(repositoryRoot, directory)));
    return discovered.flat();
  }

  private async walkMarkdown(repositoryRoot: string, directory: string): Promise<string[]> {
    const result: string[] = [];
    const pending = [directory];
    while (pending.length && result.length < 100) {
      const current = pending.pop();
      if (!current) break;
      try {
        for (const entry of await readdir(current, { withFileTypes: true })) {
          const absolute = path.join(current, entry.name);
          if (entry.isDirectory()) pending.push(absolute);
          if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
            result.push(path.relative(repositoryRoot, absolute));
          }
        }
      } catch {
        // A missing or unreadable configured plan directory is simply unavailable.
      }
    }
    return result;
  }
}

export function parseMarkdownPlan(relativePath: string, content: string, modifiedAt: string): PlanDocument {
  const lines = content.split(/\r?\n/);
  const title = lines.find((line) => /^#\s+\S/.test(line))?.replace(/^#\s+/, "").trim() ?? path.basename(relativePath, path.extname(relativePath));
  const tasks: PlanTask[] = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\s*[-*]\s+\[([^\]]+)\]\s+(.+)$/);
    if (!match) continue;
    const marker = match[1].trim().toLowerCase();
    const status: PlanTaskStatus = marker === "x" || marker === "done" || marker === "completed"
      ? "completed"
      : marker === "~" || marker === "-" || marker === ">" || marker === "in-progress" || marker === "in_progress"
        ? "in-progress"
        : "pending";
    tasks.push({ text: match[2].trim(), status, line: index + 1 });
  }
  return {
    path: relativePath,
    title,
    modifiedAt,
    excerpt: extractExcerpt(lines),
    tasks,
  };
}

function extractExcerpt(lines: string[]): string | undefined {
  const preferredHeading = lines.findIndex((line) => /^##?\s+(objective|goal|overview|summary)\s*$/i.test(line.trim()));
  const start = preferredHeading >= 0 ? preferredHeading + 1 : 0;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#") || /^[-*]\s/.test(line) || line.startsWith("```")) continue;
    const paragraph = [line];
    while (index + 1 < lines.length && lines[index + 1].trim() && !lines[index + 1].trim().startsWith("#")) {
      index += 1;
      paragraph.push(lines[index].trim());
    }
    return paragraph.join(" ").slice(0, 400);
  }
  return undefined;
}
