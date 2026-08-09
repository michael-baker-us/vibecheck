import { access, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as path from "node:path";

export type AgentInstructionAlignmentStatus =
  | "created-claude"
  | "updated-claude"
  | "already-aligned"
  | "missing-agents";

export type AgentInstructionAlignmentResult = {
  status: AgentInstructionAlignmentStatus;
  changed: boolean;
};

export type AgentAlignmentSurface = "instructions" | "plans" | "skills" | "agents" | "mcp" | "hooks" | "settings";
export type AgentAlignmentItemStatus = "aligned" | "shared" | "codex-only" | "claude-only" | "conflict" | "review" | "not-configured";

export type AgentAlignmentItem = {
  id: string;
  surface: AgentAlignmentSurface;
  label: string;
  status: AgentAlignmentItemStatus;
  detail: string;
  automatic: boolean;
  codexPath?: string;
  claudePath?: string;
  newer?: "codex" | "claude";
};

export type AgentAlignmentSnapshot = {
  items: AgentAlignmentItem[];
  driftCount: number;
  updatedAt: string;
};

export type SafeAlignmentSummary = {
  instructionsChanged: boolean;
  skillsCopiedToCodex: number;
  skillsCopiedToClaude: number;
  reviewRequired: number;
};

export type SkillAlignmentResult = { backupPath?: string; targetPath: string };

const SHARED_IMPORT = "@AGENTS.md";

export class AgentInstructionAlignmentService {
  public emptySnapshot(): AgentAlignmentSnapshot {
    return { items: [], driftCount: 0, updatedAt: new Date(0).toISOString() };
  }

  public async align(repositoryRoot: string): Promise<AgentInstructionAlignmentResult> {
    const agentsPath = path.join(repositoryRoot, "AGENTS.md");
    const claudePath = path.join(repositoryRoot, "CLAUDE.md");
    if (!await this.exists(agentsPath)) {
      return { status: "missing-agents", changed: false };
    }

    let existing: string;
    try {
      existing = await readFile(claudePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(
        claudePath,
        `${SHARED_IMPORT}\n\n# Claude Code\n\n<!-- Add only Claude-specific project guidance here. -->\n`,
        "utf8",
      );
      return { status: "created-claude", changed: true };
    }

    if (/^\s*@AGENTS\.md\s*$/m.test(existing)) {
      return { status: "already-aligned", changed: false };
    }

    const bom = existing.startsWith("\uFEFF") ? "\uFEFF" : "";
    const content = bom ? existing.slice(1) : existing;
    const newline = content.includes("\r\n") ? "\r\n" : "\n";
    await writeFile(claudePath, `${bom}${SHARED_IMPORT}${newline}${newline}${content}`, "utf8");
    return { status: "updated-claude", changed: true };
  }

  public async alignSafe(repositoryRoot: string): Promise<SafeAlignmentSummary> {
    const instructions = await this.align(repositoryRoot);
    const skills = await this.skillPairs(repositoryRoot);
    let skillsCopiedToCodex = 0;
    let skillsCopiedToClaude = 0;
    for (const skill of skills) {
      if (skill.status === "codex-only" && skill.codexPath && skill.claudePath) {
        await cp(path.join(repositoryRoot, path.dirname(skill.codexPath)), path.join(repositoryRoot, path.dirname(skill.claudePath)), { recursive: true });
        skillsCopiedToClaude += 1;
      }
      if (skill.status === "claude-only" && skill.codexPath && skill.claudePath) {
        await cp(path.join(repositoryRoot, path.dirname(skill.claudePath)), path.join(repositoryRoot, path.dirname(skill.codexPath)), { recursive: true });
        skillsCopiedToCodex += 1;
      }
    }
    const snapshot = await this.scan(repositoryRoot);
    return {
      instructionsChanged: instructions.changed,
      skillsCopiedToCodex,
      skillsCopiedToClaude,
      reviewRequired: snapshot.items.filter((item) => item.status === "conflict" || item.status === "review").length,
    };
  }

  public async scan(repositoryRoot: string, activePlanPath?: string): Promise<AgentAlignmentSnapshot> {
    const items: AgentAlignmentItem[] = [];
    const agentsExists = await this.exists(path.join(repositoryRoot, "AGENTS.md"));
    const claudeExists = await this.exists(path.join(repositoryRoot, "CLAUDE.md"));
    const claudeContent = claudeExists ? await readFile(path.join(repositoryRoot, "CLAUDE.md"), "utf8") : "";
    const instructionAligned = agentsExists && /^\s*@AGENTS\.md\s*$/m.test(claudeContent);
    const instructionNewer = await this.newerSide(repositoryRoot, agentsExists ? ["AGENTS.md"] : [], claudeExists ? ["CLAUDE.md"] : []);
    const claudeSpecific = claudeContent.replace(/^\s*@AGENTS\.md\s*$/m, "").replace(/^# Claude Code\s*$/m, "").replace(/<!-- Add only Claude-specific project guidance here\. -->/g, "").trim();
    items.push({
      id: "instructions:root",
      surface: "instructions",
      label: "Repository instructions",
      status: instructionAligned
        ? instructionNewer === "claude" && claudeSpecific ? "review" : "aligned"
        : agentsExists ? "codex-only" : claudeExists ? "claude-only" : "not-configured",
      detail: instructionAligned && instructionNewer === "claude" && claudeSpecific
        ? "CLAUDE.md changed more recently and contains provider-specific guidance. Review whether any of it should move into canonical AGENTS.md for Codex."
        : agentsExists
        ? "AGENTS.md is canonical; CLAUDE.md imports it without duplicating shared guidance."
        : claudeExists ? "Claude guidance exists without canonical AGENTS.md guidance for Codex." : "No root provider instructions are configured.",
      automatic: agentsExists,
      codexPath: "AGENTS.md",
      claudePath: "CLAUDE.md",
      ...(instructionNewer ? { newer: instructionNewer } : {}),
    });
    items.push({
      id: "plans:active",
      surface: "plans",
      label: "Active repository plan",
      status: activePlanPath ? "shared" : "not-configured",
      detail: activePlanPath
        ? `${activePlanPath} is provider-neutral and can be continued from either agent.`
        : "Choose a repository Markdown plan so both agents follow the same durable intent.",
      automatic: false,
      ...(activePlanPath ? { codexPath: activePlanPath, claudePath: activePlanPath } : {}),
    });
    items.push(...await this.skillPairs(repositoryRoot));
    items.push(...await this.manualPairs(repositoryRoot, "agents", ".codex/agents", ".claude/agents", "Custom subagents", "Agent definitions use different TOML and Markdown schemas; review tool, model, and permission semantics before translating."));
    items.push(await this.manualFilePair(repositoryRoot, "mcp", "MCP servers", ".codex/config.toml", ".mcp.json", "Server transports map broadly, but authentication, approval, and tool-policy fields require review."));
    items.push(await this.manualFilePair(repositoryRoot, "hooks", "Lifecycle hooks", ".codex/hooks.json", ".claude/settings.json", "Hook events and result contracts differ. VibeCheck flags the newer side rather than copying unsafe automation."));
    items.push(await this.manualFilePair(repositoryRoot, "settings", "Provider settings", ".codex/config.toml", ".claude/settings.json", "Models, permissions, sandboxing, and provider-only features remain independent."));
    const driftCount = items.filter((item) => ["codex-only", "claude-only", "conflict", "review"].includes(item.status)).length;
    return { items, driftCount, updatedAt: new Date().toISOString() };
  }

  public async alignSkill(
    repositoryRoot: string,
    name: string,
    source: "codex" | "claude",
    backupRoot: string,
  ): Promise<SkillAlignmentResult> {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("Invalid skill name.");
    const sourceDirectory = path.join(repositoryRoot, source === "codex" ? ".agents/skills" : ".claude/skills", name);
    const targetRelative = path.join(source === "codex" ? ".claude/skills" : ".agents/skills", name);
    const targetDirectory = path.join(repositoryRoot, targetRelative);
    if (!await this.exists(path.join(sourceDirectory, "SKILL.md"))) throw new Error(`The ${source} skill does not exist.`);
    let backupPath: string | undefined;
    if (await this.exists(targetDirectory)) {
      backupPath = path.join(backupRoot, `${Date.now()}-${source === "codex" ? "claude" : "codex"}-${name}`);
      await mkdir(path.dirname(backupPath), { recursive: true });
      await cp(targetDirectory, backupPath, { recursive: true });
      await rm(targetDirectory, { recursive: true, force: true });
    }
    await mkdir(path.dirname(targetDirectory), { recursive: true });
    await cp(sourceDirectory, targetDirectory, { recursive: true });
    return { ...(backupPath ? { backupPath } : {}), targetPath: targetRelative };
  }

  private async skillPairs(repositoryRoot: string): Promise<AgentAlignmentItem[]> {
    const codexRoot = path.join(repositoryRoot, ".agents", "skills");
    const claudeRoot = path.join(repositoryRoot, ".claude", "skills");
    const names = new Set([...await this.childDirectories(codexRoot), ...await this.childDirectories(claudeRoot)]);
    const result: AgentAlignmentItem[] = [];
    for (const name of [...names].sort()) {
      const codexSkill = path.join(codexRoot, name);
      const claudeSkill = path.join(claudeRoot, name);
      const codexExists = await this.exists(path.join(codexSkill, "SKILL.md"));
      const claudeExists = await this.exists(path.join(claudeSkill, "SKILL.md"));
      const codexPath = `.agents/skills/${name}/SKILL.md`;
      const claudePath = `.claude/skills/${name}/SKILL.md`;
      let status: AgentAlignmentItemStatus = codexExists ? "codex-only" : "claude-only";
      let detail = "This open-standard skill can be copied losslessly to the other provider.";
      let newer: AgentAlignmentItem["newer"];
      if (codexExists && claudeExists) {
        const [codexDigest, claudeDigest] = await Promise.all([this.directoryDigest(codexSkill), this.directoryDigest(claudeSkill)]);
        status = codexDigest === claudeDigest ? "aligned" : "conflict";
        if (status === "conflict") {
          const [codexTime, claudeTime] = await Promise.all([this.latestModified(codexSkill), this.latestModified(claudeSkill)]);
          newer = codexTime === claudeTime ? undefined : codexTime > claudeTime ? "codex" : "claude";
          detail = `${newer ? `${newer === "codex" ? "Codex" : "Claude"} changed more recently. ` : ""}Both copies exist and differ; choose a source before overwriting either copy.`;
        } else {
          detail = "Both providers have identical skill instructions and supporting files.";
        }
      }
      result.push({ id: `skills:${name}`, surface: "skills", label: `Skill: ${name}`, status, detail, automatic: status === "codex-only" || status === "claude-only", codexPath, claudePath, ...(newer ? { newer } : {}) });
    }
    return result;
  }

  private async manualPairs(repositoryRoot: string, surface: AgentAlignmentSurface, codexDirectory: string, claudeDirectory: string, label: string, detail: string): Promise<AgentAlignmentItem[]> {
    const [codexFiles, claudeFiles] = await Promise.all([
      this.relativeFiles(path.join(repositoryRoot, codexDirectory)),
      this.relativeFiles(path.join(repositoryRoot, claudeDirectory)),
    ]);
    if (!codexFiles.length && !claudeFiles.length) return [];
    const newer = await this.newerSide(repositoryRoot, codexFiles.map((file) => path.join(codexDirectory, file)), claudeFiles.map((file) => path.join(claudeDirectory, file)));
    return [{ id: `${surface}:project`, surface, label, status: "review", detail, automatic: false, codexPath: codexDirectory, claudePath: claudeDirectory, ...(newer ? { newer } : {}) }];
  }

  private async manualFilePair(repositoryRoot: string, surface: AgentAlignmentSurface, label: string, codexPath: string, claudePath: string, detail: string): Promise<AgentAlignmentItem> {
    const codexExists = await this.exists(path.join(repositoryRoot, codexPath));
    const claudeExists = await this.exists(path.join(repositoryRoot, claudePath));
    const newer = await this.newerSide(repositoryRoot, codexExists ? [codexPath] : [], claudeExists ? [claudePath] : []);
    return { id: `${surface}:project`, surface, label, status: codexExists || claudeExists ? "review" : "not-configured", detail, automatic: false, codexPath, claudePath, ...(newer ? { newer } : {}) };
  }

  private async newerSide(repositoryRoot: string, codexFiles: string[], claudeFiles: string[]): Promise<"codex" | "claude" | undefined> {
    if (!codexFiles.length && !claudeFiles.length) return undefined;
    const codexTime = Math.max(0, ...await Promise.all(codexFiles.map(async (file) => (await stat(path.join(repositoryRoot, file))).mtimeMs)));
    const claudeTime = Math.max(0, ...await Promise.all(claudeFiles.map(async (file) => (await stat(path.join(repositoryRoot, file))).mtimeMs)));
    return codexTime === claudeTime ? undefined : codexTime > claudeTime ? "codex" : "claude";
  }

  private async childDirectories(directory: string): Promise<string[]> {
    try {
      return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async relativeFiles(directory: string, prefix = ""): Promise<string[]> {
    try {
      const entries = await readdir(path.join(directory, prefix), { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const relative = path.join(prefix, entry.name);
        if (entry.isDirectory()) files.push(...await this.relativeFiles(directory, relative));
        else if (entry.isFile()) files.push(relative);
      }
      return files.sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async directoryDigest(directory: string): Promise<string> {
    const hash = createHash("sha256");
    for (const relative of await this.relativeFiles(directory)) {
      hash.update(relative).update("\0").update(await readFile(path.join(directory, relative))).update("\0");
    }
    return hash.digest("hex");
  }

  private async latestModified(directory: string): Promise<number> {
    const files = await this.relativeFiles(directory);
    return Math.max(0, ...await Promise.all(files.map(async (file) => (await stat(path.join(directory, file))).mtimeMs)));
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
