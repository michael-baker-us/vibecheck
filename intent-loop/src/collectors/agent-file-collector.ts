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
    path: ".codex/hooks.json",
    title: "Codex lifecycle hooks",
    owner: "codex",
    kind: "hooks",
    localOnly: false,
    description: "Project-scoped lifecycle automation loaded in trusted repositories.",
  },
  {
    path: ".codex/rules/default.rules",
    title: "Codex command rules",
    owner: "codex",
    kind: "rules",
    localOnly: false,
    description: "Project command policy evaluated before commands run outside the sandbox.",
  },
  {
    path: ".codex/agents/reviewer.toml",
    title: "Codex custom agent",
    owner: "codex",
    kind: "agents",
    localOnly: false,
    description: "Example project-scoped subagent role; additional TOML agents are discovered automatically.",
  },
  {
    path: ".agents/skills/repository-workflow/SKILL.md",
    title: "Codex repository skill",
    owner: "codex",
    kind: "skills",
    localOnly: false,
    description: "Reusable repository workflow using the open Agent Skills format.",
  },
  {
    path: ".codex-plugin/plugin.json",
    title: "Codex plugin manifest",
    owner: "codex",
    kind: "plugins",
    localOnly: false,
    description: "Plugin package manifest for repositories that develop a Codex plugin.",
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
    path: ".claude/rules/project.md",
    title: "Claude project rule",
    owner: "claude",
    kind: "rules",
    localOnly: false,
    description: "Path-specific or project-wide Claude Code guidance.",
  },
  {
    path: ".claude/skills/repository-workflow/SKILL.md",
    title: "Claude repository skill",
    owner: "claude",
    kind: "skills",
    localOnly: false,
    description: "Reusable Claude Code workflow with optional supporting files and scripts.",
  },
  {
    path: ".claude/commands/example.md",
    title: "Claude legacy command",
    owner: "claude",
    kind: "prompts",
    localOnly: false,
    description: "Legacy reusable prompt command; new workflows should normally use skills.",
  },
  {
    path: ".claude/agents/reviewer.md",
    title: "Claude custom subagent",
    owner: "claude",
    kind: "agents",
    localOnly: false,
    description: "Reusable project-scoped Claude Code specialist.",
  },
  {
    path: ".claude/output-styles/project.md",
    title: "Claude output style",
    owner: "claude",
    kind: "output-styles",
    localOnly: false,
    description: "Project response role, tone, and output-format instructions.",
  },
  {
    path: ".mcp.json",
    title: "Claude MCP servers",
    owner: "claude",
    kind: "mcp",
    localOnly: false,
    description: "Team-shared project MCP server connections, approved by each user.",
  },
  {
    path: ".claude-plugin/plugin.json",
    title: "Claude plugin manifest",
    owner: "claude",
    kind: "plugins",
    localOnly: false,
    description: "Plugin package manifest for repositories that develop a Claude Code plugin.",
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
      .map((file) => this.classify(file, files))
      .filter((file): file is AgentWorkspaceFile => file !== undefined);
    return [...managed, ...extras].sort((left, right) =>
      left.owner.localeCompare(right.owner) || left.path.localeCompare(right.path),
    );
  }

  private classify(relativePath: string, repositoryFiles: string[]): AgentWorkspaceFile | undefined {
    const name = path.basename(relativePath);
    const plugin = this.pluginContext(relativePath, repositoryFiles);
    const pluginOwner = plugin?.owner;
    const pluginPath = plugin ? relativePath.slice(plugin.root.length) : undefined;
    if (pluginOwner && /^skills\/[^/]+\/SKILL\.md$/i.test(pluginPath ?? "")) {
      return this.extra(relativePath, pluginOwner, "skills", `${this.ownerLabel(pluginOwner)} plugin skill`);
    }
    if (pluginOwner && /^hooks\/.*\.json$/i.test(pluginPath ?? "")) {
      return this.extra(relativePath, pluginOwner, "hooks", `${this.ownerLabel(pluginOwner)} plugin hooks`);
    }
    if (pluginOwner && /^\.mcp\.json$/i.test(pluginPath ?? "")) {
      return this.extra(relativePath, pluginOwner, "mcp", `${this.ownerLabel(pluginOwner)} plugin MCP servers`);
    }
    if (pluginOwner === "codex" && /^\.app\.json$/i.test(pluginPath ?? "")) {
      return this.extra(relativePath, "codex", "mcp", "Codex plugin app mapping");
    }
    if (pluginOwner === "claude" && /^agents\/.*\.md$/i.test(pluginPath ?? "")) {
      return this.extra(relativePath, "claude", "agents", "Claude plugin subagent");
    }
    if (pluginOwner === "claude" && /^commands\/.*\.md$/i.test(pluginPath ?? "")) {
      return this.extra(relativePath, "claude", "prompts", "Claude plugin command");
    }
    if (pluginOwner === "claude" && /^output-styles\/.*\.md$/i.test(pluginPath ?? "")) {
      return this.extra(relativePath, "claude", "output-styles", "Claude plugin output style");
    }
    if (/^AGENTS(?:\.override)?\.md$/i.test(name)) {
      return this.extra(relativePath, "codex", "instructions", "Nested Codex instructions");
    }
    if (/(^|\/)\.agents\/skills\/[^/]+\/SKILL\.md$/i.test(relativePath)) {
      return this.extra(relativePath, "codex", "skills", "Codex repository skill");
    }
    if (/(^|\/)\.codex\/config\.toml$/i.test(relativePath)) {
      return this.extra(relativePath, "codex", "settings", "Nested Codex settings");
    }
    if (/(^|\/)\.codex\/hooks\.json$/i.test(relativePath)) {
      return this.extra(relativePath, "codex", "hooks", "Codex lifecycle hooks");
    }
    if (/(^|\/)\.codex\/rules\/.*\.rules$/i.test(relativePath)) {
      return this.extra(relativePath, "codex", "rules", "Codex command rules");
    }
    if (/(^|\/)\.codex\/agents\/.*\.toml$/i.test(relativePath)) {
      return this.extra(relativePath, "codex", "agents", "Codex custom agent");
    }
    if (/(^|\/)\.codex-plugin\/plugin\.json$/i.test(relativePath)) {
      return this.extra(relativePath, "codex", "plugins", "Codex plugin manifest");
    }
    if (/^CLAUDE(?:\.local)?\.md$/i.test(name)) {
      return this.extra(relativePath, "claude", "instructions", "Nested Claude instructions");
    }
    if (/(^|\/)\.claude\/rules\/.*\.md$/i.test(relativePath)) {
      return this.extra(
        relativePath,
        "claude",
        "rules",
        "Claude path-specific rule",
      );
    }
    if (/(^|\/)\.claude\/skills\/[^/]+\/SKILL\.md$/i.test(relativePath)) {
      return this.extra(relativePath, "claude", "skills", "Claude repository skill");
    }
    if (/(^|\/)\.claude\/commands\/.*\.md$/i.test(relativePath)) {
      return this.extra(relativePath, "claude", "prompts", "Claude legacy command");
    }
    if (/(^|\/)\.claude\/agents\/.*\.md$/i.test(relativePath)) {
      return this.extra(relativePath, "claude", "agents", "Claude custom subagent");
    }
    if (/(^|\/)\.claude\/output-styles\/.*\.md$/i.test(relativePath)) {
      return this.extra(relativePath, "claude", "output-styles", "Claude output style");
    }
    if (/(^|\/)\.claude\/settings(?:\.local)?\.json$/i.test(relativePath)) {
      return this.extra(relativePath, "claude", "settings", "Nested Claude settings and hooks");
    }
    if (/^\.mcp\.json$/i.test(relativePath)) {
      return this.extra(relativePath, "claude", "mcp", "Claude project MCP servers");
    }
    if (/(^|\/)\.claude-plugin\/(?:plugin|marketplace)\.json$/i.test(relativePath)) {
      return this.extra(relativePath, "claude", "plugins", "Claude plugin manifest");
    }
    return undefined;
  }

  private pluginContext(
    relativePath: string,
    repositoryFiles: string[],
  ): { root: string; owner: "codex" | "claude" } | undefined {
    const candidates = repositoryFiles.flatMap((file): { root: string; owner: "codex" | "claude" }[] => {
      if (/(^|\/)\.codex-plugin\/plugin\.json$/i.test(file)) {
        return [{ root: file.slice(0, -".codex-plugin/plugin.json".length), owner: "codex" }];
      }
      if (/(^|\/)\.claude-plugin\/plugin\.json$/i.test(file)) {
        return [{ root: file.slice(0, -".claude-plugin/plugin.json".length), owner: "claude" }];
      }
      return [];
    });
    return candidates
      .filter((candidate) => relativePath.startsWith(candidate.root))
      .sort((left, right) => right.root.length - left.root.length)[0];
  }

  private ownerLabel(owner: "codex" | "claude"): string {
    return owner === "codex" ? "Codex" : "Claude";
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
      description: "Discovered in the repository agent capability hierarchy.",
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
