import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

export type SupportedAgent = "codex" | "claude";
export type AdapterInstallationStatus = Record<SupportedAgent, boolean>;

type HookHandler = { type?: unknown; command?: unknown; timeout?: unknown };
type HookGroup = { matcher?: unknown; hooks?: HookHandler[] };
type HookConfiguration = {
  description?: string;
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
};

/**
 * `Stop` and `SubagentStop` mark the end of a turn and of a delegation; without them a session
 * appears to run forever. `SubagentStart` and `PreToolUse` carry the delegation identifier and the
 * tool a session is currently running, which is what the Team activity view reports.
 */
const EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "Stop",
];

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
    const bridgeTemporary = `${this.installedBridge}.${process.pid}.tmp`;
    await copyFile(this.packagedBridge, bridgeTemporary);
    await this.replaceFile(bridgeTemporary, this.installedBridge);
    const configPath = this.configPath(agent);
    await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    const configuration = await this.readConfiguration(configPath);
    configuration.hooks ??= {};
    const command = this.command(agent);
    for (const event of EVENTS) {
      const groups = (configuration.hooks[event] ??= []);
      const timeout = event === "SessionEnd" || event.endsWith("ToolUse") ? 3 : 10;
      let repaired = false;
      for (const group of groups) {
        for (const handler of group.hooks ?? []) {
          if (handler.command !== command) continue;
          handler.type = "command";
          handler.timeout = timeout;
          if (event === "PostToolUse" || event === "PreToolUse") group.matcher = "*";
          repaired = true;
        }
      }
      if (!repaired) {
        groups.push({
          ...(event === "PostToolUse" || event === "PreToolUse" ? { matcher: "*" } : {}),
          // Tool hooks sit on the critical path of every call, so they get a short budget; the
          // bridge only appends a line, and a slow one must never stall a session.
          hooks: [{
            type: "command",
            command,
            timeout,
          }],
        });
      }
    }
    await this.writeConfiguration(configPath, configuration);
    return configPath;
  }

  /**
   * Reports only whether every VibeCheck hook command is present in provider configuration.
   * Provider trust/approval is deliberately outside this result and can only be established by
   * observing lifecycle events emitted by the provider.
   */
  public async isInstalled(agent: SupportedAgent): Promise<boolean> {
    try {
      if (!(await stat(this.installedBridge)).isFile()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const configuration = await this.readConfiguration(this.configPath(agent));
    const command = this.command(agent);
    return EVENTS.every((event) =>
      configuration.hooks?.[event]?.some((group) =>
        group.hooks?.some((handler) => handler.type === "command" && handler.command === command),
      ) === true,
    );
  }

  public async installationStatus(): Promise<AdapterInstallationStatus> {
    const [codex, claude] = await Promise.all([
      this.isInstalled("codex"),
      this.isInstalled("claude"),
    ]);
    return { codex, claude };
  }

  /** Detects any exact VibeCheck bridge command, including a partially installed legacy adapter. */
  public async hasConfiguredHooks(agent: SupportedAgent): Promise<boolean> {
    const configuration = await this.readConfiguration(this.configPath(agent));
    const command = this.command(agent);
    return Object.values(configuration.hooks ?? {}).some((groups) =>
      groups.some((group) => group.hooks?.some((handler) => handler.command === command) === true),
    );
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
    await this.writeConfiguration(configPath, configuration);
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

  private async writeConfiguration(configPath: string, configuration: HookConfiguration): Promise<void> {
    const temporary = `${configPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
    await this.replaceFile(temporary, configPath, 0o600);
  }

  private async replaceFile(temporary: string, destination: string, mode?: number): Promise<void> {
    try {
      await rename(temporary, destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      // Windows cannot atomically rename over an existing file. Overwrite it, then remove the
      // fully-written temporary file; this keeps reinstall working without deleting first.
      await copyFile(temporary, destination);
      await rm(temporary, { force: true });
    }
    if (mode !== undefined) await chmod(destination, mode);
  }
}
