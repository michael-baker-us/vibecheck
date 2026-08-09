import { access } from "node:fs/promises";
import * as path from "node:path";

import { GitCollector } from "./git-collector";
import { AgentWorkspaceFile } from "../domain/agent-files";

const MANAGED_FILES: Omit<AgentWorkspaceFile, "exists">[] = [
  {
    path: "AGENTS.md",
    title: "Codex instructions",
    owner: "codex",
    kind: "instructions",
    localOnly: false,
    description: "Shared repository guidance loaded by Codex.",
  },
  {
    path: "CLAUDE.md",
    title: "Claude instructions",
    owner: "claude",
    kind: "instructions",
    localOnly: false,
    description: "Shared repository guidance loaded by Claude Code.",
  },
  {
    path: "CLAUDE.local.md",
    title: "Local Claude instructions",
    owner: "claude",
    kind: "instructions",
    localOnly: true,
    description: "Personal project guidance that should remain gitignored.",
  },
  {
    path: ".codex/config.toml",
    title: "Codex project settings",
    owner: "codex",
    kind: "settings",
    localOnly: false,
    description: "Project-scoped Codex settings for trusted repositories.",
  },
  {
    path: ".claude/settings.json",
    title: "Claude project settings",
    owner: "claude",
    kind: "settings",
    localOnly: false,
    description: "Team-shared Claude Code settings.",
  },
  {
    path: ".claude/settings.local.json",
    title: "Local Claude settings",
    owner: "claude",
    kind: "settings",
    localOnly: true,
    description: "Personal Claude Code settings that should remain gitignored.",
  },
  {
    path: ".intent-loop/config.yaml",
    title: "Quality gates",
    owner: "intent-loop",
    kind: "settings",
    localOnly: false,
    description: "Tests, coverage, security, plan discovery, and other checks.",
  },
  {
    path: ".intent-loop/rules.yaml",
    title: "Repository guardrails",
    owner: "intent-loop",
    kind: "rules",
    localOnly: false,
    description: "Deterministic architecture boundaries and repository rules.",
  },
];

export class AgentFileCollector {
  public constructor(private readonly git: GitCollector) {}

  public async collect(repositoryRoot: string): Promise<AgentWorkspaceFile[]> {
    const managed = await Promise.all(MANAGED_FILES.map(async (file) => ({
      ...file,
      exists: await this.exists(path.join(repositoryRoot, file.path)),
    })));
    const known = new Set(managed.map((file) => file.path));
    const files = await this.git.listRepositoryFiles(repositoryRoot);
    const extras = files
      .filter((file) => !known.has(file))
      .map((file) => this.classify(file))
      .filter((file): file is AgentWorkspaceFile => file !== undefined);
    return [...managed, ...extras].sort((left, right) =>
      left.owner.localeCompare(right.owner) || left.path.localeCompare(right.path),
    );
  }

  private classify(relativePath: string): AgentWorkspaceFile | undefined {
    const name = path.basename(relativePath);
    if (/^AGENTS(?:\.override)?\.md$/i.test(name)) {
      return this.extra(relativePath, "codex", "instructions", "Nested Codex instructions");
    }
    if (/^CLAUDE(?:\.local)?\.md$/i.test(name) || /^\.claude\/rules\/.*\.md$/i.test(relativePath)) {
      return this.extra(
        relativePath,
        "claude",
        relativePath.includes("/rules/") ? "rules" : "instructions",
        relativePath.includes("/rules/") ? "Claude path-specific rule" : "Nested Claude instructions",
      );
    }
    return undefined;
  }

  private extra(
    relativePath: string,
    owner: AgentWorkspaceFile["owner"],
    kind: AgentWorkspaceFile["kind"],
    title: string,
  ): AgentWorkspaceFile {
    return {
      path: relativePath,
      title,
      owner,
      kind,
      exists: true,
      localOnly: /\.local\./i.test(relativePath),
      description: "Discovered in the repository instruction hierarchy.",
    };
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
