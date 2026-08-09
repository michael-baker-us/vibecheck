import { access, mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import * as vscode from "vscode";

import { AdapterInstaller, SupportedAgent } from "./adapters/adapter-installer";
import { LocalEventReader } from "./adapters/local-event-reader";
import { AnalysisEngine } from "./analyzers/analysis-engine";
import { AgentFileCollector } from "./collectors/agent-file-collector";
import { GitCollector } from "./collectors/git-collector";
import { PlanCollector } from "./collectors/plan-collector";
import { ConfigLoader } from "./config/config-loader";
import { Finding } from "./domain/findings";
import { ObservationController } from "./observation-controller";
import { buildFollowUpPrompt } from "./prompts/follow-up-builder";
import { buildMarkdownReport } from "./reports/markdown-report";
import { WorkspaceStore } from "./storage/workspace-store";
import { FindingDiagnostics } from "./ui/diagnostics";
import { ControlCenterProvider } from "./ui/control-center";
import { IntentLoopStatusBar } from "./ui/status-bar";
import { VerificationService } from "./verification/verification-service";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("VibeCheck", { log: true });
  context.subscriptions.push(output);
  const workspaceFolder = selectWorkspaceFolder();
  if (!workspaceFolder) {
    output.appendLine("VibeCheck requires an open workspace folder.");
    return;
  }

  const git = new GitCollector();
  const adapters = new AdapterInstaller(context.asAbsolutePath("resources/hook-bridge.cjs"));
  const statusBar = new IntentLoopStatusBar();
  const diagnostics = new FindingDiagnostics();
  let controller: ObservationController;
  const controlCenter = new ControlCenterProvider(
    () => controller.getSnapshot(),
    () => controller.getConfiguration(),
    () => controller.getConfigurationError(),
  );
  controller = new ObservationController(
    workspaceFolder,
    new WorkspaceStore(context.workspaceState),
    git,
    new PlanCollector(git),
    new AgentFileCollector(git),
    new ConfigLoader(),
    new AnalysisEngine(),
    new VerificationService(git),
    () => {
      const snapshot = controller.getSnapshot();
      controlCenter.refresh();
      statusBar.render(snapshot);
      diagnostics.render(snapshot);
    },
    output,
  );
  const eventReader = new LocalEventReader(
    (event) => void controller.ingestAgentEvent(event),
    output,
  );

  context.subscriptions.push(
    statusBar,
    diagnostics,
    controller,
    eventReader,
    vscode.window.registerWebviewViewProvider("intentLoop.overview", controlCenter, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("intentLoop.start", () => controller.resume()),
    vscode.commands.registerCommand("intentLoop.pause", () => controller.pause()),
    vscode.commands.registerCommand("intentLoop.refresh", () => controller.refresh()),
    vscode.commands.registerCommand("intentLoop.selectPlan", () => selectPlan(controller)),
    vscode.commands.registerCommand("intentLoop.openPlan", () => openPlan(controller)),
    vscode.commands.registerCommand("intentLoop.inspectFinding", (argument?: Finding) =>
      withFinding(argument, (finding) => inspectFinding(controller, finding)),
    ),
    vscode.commands.registerCommand("intentLoop.acceptFinding", (argument?: Finding) =>
      withFinding(argument, (finding) => controller.setFindingStatus(finding.id, "accepted")),
    ),
    vscode.commands.registerCommand("intentLoop.dismissFinding", (argument?: Finding) =>
      withFinding(argument, (finding) => controller.setFindingStatus(finding.id, "dismissed")),
    ),
    vscode.commands.registerCommand("intentLoop.reopenFinding", (argument?: Finding) =>
      withFinding(argument, (finding) => controller.setFindingStatus(finding.id, "open")),
    ),
    vscode.commands.registerCommand("intentLoop.copyPrompt", (argument?: Finding) =>
      copyPrompt(controller, argument),
    ),
    vscode.commands.registerCommand("intentLoop.runVerification", (argument?: string) =>
      runVerificationCommand(controller, argument),
    ),
    vscode.commands.registerCommand("intentLoop.runAllVerification", async () => {
      if (controller.getConfiguration().verification.length === 0) {
        const choice = await vscode.window.showInformationMessage(
          "No VibeCheck verification commands are configured.",
          "Open Configuration",
        );
        if (choice === "Open Configuration") await openConfiguration(controller);
        return;
      }
      for (const definition of controller.getConfiguration().verification) {
        await runVerification(controller, definition.name);
      }
    }),
    vscode.commands.registerCommand("intentLoop.showVerificationOutput", async (argument?: string) => {
      const name = argument ?? (await chooseVerification(controller, "Select verification output"));
      if (!name) return;
      const snapshot = controller.getSnapshot();
      if (snapshot.kind !== "ready") return;
      const verification = snapshot.state.verification.find((item) => item.name === name);
      output.appendLine(`\n[${name}]\n${verification?.output ?? "No output recorded."}`);
      output.show(true);
    }),
    vscode.commands.registerCommand("intentLoop.openConfig", () => openConfiguration(controller)),
    vscode.commands.registerCommand("intentLoop.manageAgentFile", (relativePath?: string) =>
      manageAgentFile(controller, relativePath),
    ),
    vscode.commands.registerCommand("intentLoop.installCodexAdapter", () =>
      installAdapter(adapters, "codex"),
    ),
    vscode.commands.registerCommand("intentLoop.installClaudeAdapter", () =>
      installAdapter(adapters, "claude"),
    ),
    vscode.commands.registerCommand("intentLoop.uninstallAgentAdapter", () =>
      uninstallAdapter(adapters),
    ),
    vscode.commands.registerCommand("intentLoop.createReport", () => createEvidenceReport(controller)),
    vscode.commands.registerCommand("intentLoop.deleteData", () => deleteData(controller, adapters)),
  );

  statusBar.render(controller.getSnapshot());
  await controller.initialize();
  eventReader.start();
}

export function deactivate(): void {
  // Disposables registered with the extension context are released by VS Code.
}

async function selectPlan(controller: ObservationController): Promise<void> {
  const snapshot = controller.getSnapshot();
  if (snapshot.kind !== "ready") return;
  const browseLabel = "$(folder-opened) Choose another Markdown file…";
  const selected = await vscode.window.showQuickPick([
    ...snapshot.state.planCandidates.map((plan) => ({
      label: plan.title,
      description: plan.path,
      detail: plan.excerpt,
      planPath: plan.path,
    })),
    { label: browseLabel, planPath: undefined },
  ], {
    title: "Choose the active repository plan",
    placeHolder: "VibeCheck follows this plan instead of maintaining a separate intent",
  });
  if (!selected) return;
  let planPath = selected.planPath;
  if (!planPath) {
    const picked = await vscode.window.showOpenDialog({
      title: "Choose a Markdown plan inside this repository",
      defaultUri: vscode.Uri.file(snapshot.state.repositoryRoot),
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { Markdown: ["md"] },
    });
    if (!picked?.[0]) return;
    const relative = path.relative(snapshot.state.repositoryRoot, picked[0].fsPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      void vscode.window.showWarningMessage("Choose a plan inside the observed repository.");
      return;
    }
    planPath = relative;
  }
  await controller.selectPlan(planPath);
}

async function openPlan(controller: ObservationController): Promise<void> {
  const snapshot = controller.getSnapshot();
  if (snapshot.kind !== "ready") return;
  if (!snapshot.state.activePlan) {
    await selectPlan(controller);
    return;
  }
  const uri = vscode.Uri.file(path.join(snapshot.state.repositoryRoot, snapshot.state.activePlan.path));
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
}

async function manageAgentFile(
  controller: ObservationController,
  relativePath?: string,
): Promise<void> {
  const snapshot = controller.getSnapshot();
  if (snapshot.kind !== "ready" || !relativePath) return;
  const definition = snapshot.state.agentFiles.find((file) => file.path === relativePath);
  if (!definition) return;
  if (relativePath === ".intent-loop/config.yaml") {
    await openConfiguration(controller);
    return;
  }

  const absolutePath = path.resolve(snapshot.state.repositoryRoot, relativePath);
  const relative = path.relative(snapshot.state.repositoryRoot, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return;
  if (!definition.exists) {
    const choice = await vscode.window.showInformationMessage(
      `Create ${relativePath}?`,
      { modal: true, detail: definition.description },
      "Create File",
    );
    if (choice !== "Create File") return;
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, agentFileTemplate(relativePath, snapshot.state.agentFiles.some((file) => file.path === "AGENTS.md" && file.exists)), "utf8");
    if (definition.localOnly) {
      void vscode.window.showInformationMessage(`${relativePath} is personal. Confirm it is covered by this repository's .gitignore.`);
    }
    await controller.refresh();
  }
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(absolutePath));
}

function agentFileTemplate(relativePath: string, hasAgentsFile: boolean): string {
  if (relativePath === "AGENTS.md") {
    return "# Repository Instructions\n\n## Verification\n\n<!-- Add the commands Codex should run before considering work complete. -->\n\n## Architecture\n\n<!-- Add durable project boundaries and conventions. -->\n";
  }
  if (relativePath === "CLAUDE.md") {
    return `${hasAgentsFile ? "@AGENTS.md\n\n" : ""}# Claude Code\n\n<!-- Add only Claude-specific project guidance here. -->\n`;
  }
  if (relativePath === "CLAUDE.local.md") {
    return "# Local Claude Code Instructions\n\n<!-- Personal project guidance. Keep this file out of version control. -->\n";
  }
  if (relativePath === ".codex/config.toml") {
    return "# Project-scoped Codex settings. Codex loads this file only for trusted projects.\n# MCP servers and lifecycle hooks can also be configured here.\n";
  }
  if (relativePath === ".codex/hooks.json") {
    return "{\n  \"description\": \"Project lifecycle hooks\",\n  \"hooks\": {}\n}\n";
  }
  if (relativePath === ".codex/rules/default.rules") {
    return "# Project command policy. Add reviewed prefix_rule(...) entries here.\n";
  }
  if (relativePath === ".codex/agents/reviewer.toml") {
    return "name = \"reviewer\"\ndescription = \"Reviews changes for correctness, risk, and missing verification.\"\ndeveloper_instructions = \"Inspect the requested change and report concrete, evidence-backed findings.\"\n";
  }
  if (relativePath === ".agents/skills/repository-workflow/SKILL.md") {
    return "---\nname: repository-workflow\ndescription: Follow this repository's repeatable engineering workflow.\n---\n\n# Repository workflow\n\n<!-- Add focused steps, expected inputs, verification, and output requirements. -->\n";
  }
  if (relativePath === ".codex-plugin/plugin.json") {
    return "{\n  \"name\": \"repository-plugin\",\n  \"version\": \"0.1.0\",\n  \"description\": \"Repository Codex plugin\"\n}\n";
  }
  if (relativePath === ".claude/settings.json" || relativePath === ".claude/settings.local.json") {
    return "{}\n";
  }
  if (relativePath === ".claude/rules/project.md") {
    return "---\npaths:\n  - \"**/*\"\n---\n\n# Project rule\n\n<!-- Add focused Claude Code guidance. Narrow the paths when appropriate. -->\n";
  }
  if (relativePath === ".claude/skills/repository-workflow/SKILL.md") {
    return "---\nname: repository-workflow\ndescription: Follow this repository's repeatable engineering workflow.\n---\n\n# Repository workflow\n\n<!-- Add focused steps, expected inputs, verification, and output requirements. -->\n";
  }
  if (relativePath === ".claude/commands/example.md") {
    return "---\ndescription: Example legacy command; prefer a skill for new reusable workflows.\n---\n\n<!-- Add the reusable prompt. -->\n";
  }
  if (relativePath === ".claude/agents/reviewer.md") {
    return "---\nname: reviewer\ndescription: Reviews changes for correctness, risk, and missing verification.\ntools: Read, Grep, Glob\n---\n\nInspect the requested change and report concrete, evidence-backed findings.\n";
  }
  if (relativePath === ".claude/output-styles/project.md") {
    return "---\nname: Project\ndescription: Project-specific response style.\nkeep-coding-instructions: true\n---\n\n<!-- Describe the desired response format and tone. -->\n";
  }
  if (relativePath === ".mcp.json") {
    return "{\n  \"mcpServers\": {}\n}\n";
  }
  if (relativePath === ".claude-plugin/plugin.json") {
    return "{\n  \"name\": \"repository-plugin\",\n  \"version\": \"0.1.0\",\n  \"description\": \"Repository Claude Code plugin\"\n}\n";
  }
  if (relativePath === ".intent-loop/rules.yaml") {
    return "# Deterministic repository boundaries.\nboundaries: []\n";
  }
  return "";
}

async function inspectFinding(controller: ObservationController, finding: Finding): Promise<void> {
  const snapshot = controller.getSnapshot();
  if (snapshot.kind !== "ready") return;
  const evidence = finding.evidence.find((item) => item.path);
  if (evidence?.path) {
    const uri = vscode.Uri.file(path.join(snapshot.state.repositoryRoot, evidence.path));
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document);
      if (evidence.line) {
        const position = new vscode.Position(Math.max(0, evidence.line - 1), 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      }
      return;
    } catch {
      // Deleted files and binary evidence fall back to a local diff document.
    }
  }
  const diff = await controller.getDiff(evidence?.path);
  const document = await vscode.workspace.openTextDocument({
    language: "diff",
    content: diff || `${finding.title}\n\n${finding.explanation}`,
  });
  await vscode.window.showTextDocument(document, { preview: true });
}

async function copyPrompt(controller: ObservationController, finding?: Finding): Promise<void> {
  const snapshot = controller.getSnapshot();
  if (snapshot.kind !== "ready") return;
  const prompt = buildFollowUpPrompt(snapshot.state, finding ? [finding.id] : undefined);
  await vscode.env.clipboard.writeText(prompt);
  void vscode.window.showInformationMessage("VibeCheck follow-up prompt copied locally.");
}

async function runVerification(controller: ObservationController, name: string): Promise<void> {
  const snapshot = controller.getSnapshot();
  if (snapshot.kind !== "ready") return;
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage("Trust this VS Code workspace before running verification commands.");
    return;
  }
  const definition = controller.getConfiguration().verification.find((item) => item.name === name);
  if (!definition) return;
  if (!controller.isVerificationTrusted(name)) {
    const choice = await vscode.window.showWarningMessage(
      `Allow VibeCheck to run this local command in ${snapshot.state.repositoryRoot}?\n\n${definition.command}`,
      { modal: true },
      "Trust and Run",
    );
    if (choice !== "Trust and Run") return;
    await controller.trustVerification(name);
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `VibeCheck: ${name}`,
      cancellable: true,
    },
    async (_progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      await controller.runVerification(name, abort.signal);
    },
  );
}

async function runVerificationCommand(
  controller: ObservationController,
  argument?: string,
): Promise<void> {
  const name = argument ?? (await chooseVerification(controller, "Run verification"));
  if (name) await runVerification(controller, name);
}

async function chooseVerification(
  controller: ObservationController,
  title: string,
): Promise<string | undefined> {
  const definitions = controller.getConfiguration().verification;
  if (definitions.length === 0) {
    void vscode.window.showInformationMessage("No VibeCheck verification commands are configured.");
    return undefined;
  }
  const selected = await vscode.window.showQuickPick(
    definitions.map((definition) => ({ label: definition.name, description: definition.command })),
    { title },
  );
  return selected?.label;
}

async function openConfiguration(controller: ObservationController): Promise<void> {
  const snapshot = controller.getSnapshot();
  if (snapshot.kind !== "ready") return;
  const directory = path.join(snapshot.state.repositoryRoot, ".intent-loop");
  const configPath = path.join(directory, "config.yaml");
  try {
    await access(configPath);
  } catch {
    await mkdir(directory, { recursive: true });
    await writeFile(
      configPath,
      [
        "# VibeCheck runs only commands you explicitly trust in VS Code.",
        "plans:",
        "  include:",
        "    - PLAN.md",
        "    - plans/**/*.md",
        "    - docs/**/*plan*.md",
        "    - .claude/plans/*.md",
        "# active: plans/current.md  # Optional shared default; the UI can select locally.",
        "",
        "verification:",
        "  - name: tests",
        "    category: tests",
        "    required: true",
        "    command: npm test",
        "    invalidated_by:",
        "      - src/**",
        "      - test/**",
        "      - tests/**",
        "      - package.json",
        "      - package-lock.json",
        "",
        "# Recommended: add required coverage and security checks for your stack.",
        "#  - name: coverage",
        "#    category: coverage",
        "#    required: true",
        "#    command: npm run coverage",
        "#    invalidated_by: [src/**, test/**, tests/**]",
        "#  - name: dependency security",
        "#    category: security",
        "#    required: true",
        "#    command: npm audit --audit-level=high",
        "#    invalidated_by: [package.json, package-lock.json]",
        "",
        "diff_expansion_threshold: 15",
        "",
      ].join("\n"),
      "utf8",
    );
  }
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(configPath));
  await controller.refresh();
}

async function createEvidenceReport(controller: ObservationController): Promise<void> {
  const snapshot = controller.getSnapshot();
  if (snapshot.kind !== "ready") return;
  const document = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: buildMarkdownReport(snapshot.state),
  });
  await vscode.window.showTextDocument(document, { preview: false });
  void vscode.window.showInformationMessage("Evidence report created locally. Save it only if you want a repository artifact.");
}

async function installAdapter(adapters: AdapterInstaller, agent: SupportedAgent): Promise<void> {
  const configPath = adapters.configPath(agent);
  const choice = await vscode.window.showWarningMessage(
    `Install the local VibeCheck ${agent} hook adapter? This will merge observer hooks into ${configPath}. Prompts and raw transcripts are not retained.`,
    { modal: true },
    "Install Local Adapter",
  );
  if (choice !== "Install Local Adapter") return;
  try {
    await adapters.install(agent);
    const suffix =
      agent === "codex"
        ? " Open /hooks in Codex to review and trust the new hook definitions."
        : " Restart active Claude sessions so they load the hooks.";
    void vscode.window.showInformationMessage(`VibeCheck ${agent} adapter installed.${suffix}`);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not install ${agent} adapter: ${String(error)}`);
  }
}

async function uninstallAdapter(adapters: AdapterInstaller): Promise<void> {
  const agent = await vscode.window.showQuickPick(["codex", "claude"] as const, {
    title: "Remove a VibeCheck agent adapter",
  });
  if (!agent) return;
  const selectedAgent = agent as SupportedAgent;
  const choice = await vscode.window.showWarningMessage(
    `Remove VibeCheck hook commands from ${adapters.configPath(selectedAgent)}? Other hooks will be preserved.`,
    { modal: true },
    "Remove Adapter",
  );
  if (choice !== "Remove Adapter") return;
  try {
    await adapters.uninstall(selectedAgent);
    void vscode.window.showInformationMessage(`VibeCheck ${selectedAgent} adapter removed.`);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not remove ${selectedAgent} adapter: ${String(error)}`);
  }
}

async function deleteData(
  controller: ObservationController,
  adapters: AdapterInstaller,
): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    "Delete this workspace's VibeCheck state and the local shared agent-event log? Agent hook configuration will remain installed.",
    { modal: true },
    "Delete Local Data",
  );
  if (choice === "Delete Local Data") {
    await Promise.all([controller.deleteData(), adapters.deleteLocalEvents()]);
  }
}

function selectWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return undefined;
  if (folders.length > 1) {
    void vscode.window.showInformationMessage(
      `VibeCheck currently observes the first workspace folder: ${folders[0].name}.`,
    );
  }
  return folders[0];
}

async function withFinding(
  argument: Finding | undefined,
  action: (finding: Finding) => Promise<void>,
): Promise<void> {
  if (argument) await action(argument);
}
