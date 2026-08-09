import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

export type SupportedAgent = "codex" | "claude";

type HookHandler = { type?: unknown; command?: unknown; timeout?: unknown };
type HookGroup = { matcher?: unknown; hooks?: HookHandler[] };
type HookConfiguration = {
  description?: string;
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
};

const EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PostToolUse"];

export class AdapterInstaller {
  private readonly installRoot: string;
  private readonly installedBridge: string;

  public constructor(
    private readonly packagedBridge: string,
    private readonly userHome = homedir(),
  ) {
    this.installRoot = path.join(userHome, ".vibecheck");
    this.installedBridge = path.join(this.installRoot, "bin", "hook-bridge.cjs");
  }

  public configPath(agent: SupportedAgent): string {
    return agent === "codex"
      ? path.join(this.userHome, ".codex", "hooks.json")
      : path.join(this.userHome, ".claude", "settings.json");
  }

  public async install(agent: SupportedAgent): Promise<string> {
    await mkdir(path.dirname(this.installedBridge), { recursive: true, mode: 0o700 });
    await copyFile(this.packagedBridge, this.installedBridge);
    const configPath = this.configPath(agent);
    await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    const configuration = await this.readConfiguration(configPath);
    configuration.hooks ??= {};
    const command = this.command(agent);
    for (const event of EVENTS) {
      const groups = (configuration.hooks[event] ??= []);
      if (!groups.some((group) => group.hooks?.some((handler) => handler.command === command))) {
        groups.push({
          ...(event === "PostToolUse" ? { matcher: "*" } : {}),
          hooks: [{ type: "command", command, timeout: event === "SessionEnd" ? 3 : 10 }],
        });
      }
    }
    await writeFile(configPath, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
    return configPath;
  }

  public async uninstall(agent: SupportedAgent): Promise<string> {
    const configPath = this.configPath(agent);
    const configuration = await this.readConfiguration(configPath);
    const command = this.command(agent);
    if (configuration.hooks) {
      for (const [event, groups] of Object.entries(configuration.hooks)) {
        const retained = groups
          .map((group) => ({
            ...group,
            hooks: group.hooks?.filter((handler) => handler.command !== command),
          }))
          .filter((group) => (group.hooks?.length ?? 0) > 0);
        if (retained.length > 0) configuration.hooks[event] = retained;
        else delete configuration.hooks[event];
      }
      if (Object.keys(configuration.hooks).length === 0) delete configuration.hooks;
    }
    await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    await writeFile(configPath, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
    return configPath;
  }

  public async deleteLocalEvents(): Promise<void> {
    await Promise.all([
      rm(path.join(this.installRoot, "events.jsonl"), { force: true }),
      rm(path.join(this.installRoot, "events.previous.jsonl"), { force: true }),
    ]);
  }

  private command(agent: SupportedAgent): string {
    const escaped = this.installedBridge.replaceAll('"', '\\"');
    return `node "${escaped}" ${agent}`;
  }

  private async readConfiguration(configPath: string): Promise<HookConfiguration> {
    try {
      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${configPath} must contain a JSON object.`);
      }
      return parsed as HookConfiguration;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
}
