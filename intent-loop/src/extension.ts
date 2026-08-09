import { access, mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import * as vscode from "vscode";

import { AdapterInstaller, SupportedAgent } from "./adapters/adapter-installer";
import { LocalEventReader } from "./adapters/local-event-reader";
import { AnalysisEngine } from "./analyzers/analysis-engine";
import { GitCollector } from "./collectors/git-collector";
import { PlanCollector } from "./collectors/plan-collector";
import { ConfigLoader } from "./config/config-loader";
import { Finding } from "./domain/findings";
import { calculateReadiness, missingRecommendedCategories } from "./domain/quality-gates";
import { ObservationController } from "./observation-controller";
import { buildFollowUpPrompt } from "./prompts/follow-up-builder";
import { buildMarkdownReport } from "./reports/markdown-report";
import { WorkspaceStore } from "./storage/workspace-store";
import { FindingDiagnostics } from "./ui/diagnostics";
import { ControlCenterProvider } from "./ui/control-center";
import { IntentLoopStatusBar } from "./ui/status-bar";
import { VerificationService } from "./verification/verification-service";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Intent Loop", { log: true });
  context.subscriptions.push(output);
  const workspaceFolder = selectWorkspaceFolder();
  if (!workspaceFolder) {
    output.appendLine("Intent Loop requires an open workspace folder.");
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
          "No Intent Loop verification commands are configured.",
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
    vscode.commands.registerCommand("intentLoop.installCodexAdapter", () =>
      installAdapter(adapters, "codex"),
    ),
    vscode.commands.registerCommand("intentLoop.installClaudeAdapter", () =>
      installAdapter(adapters, "claude"),
    ),
    vscode.commands.registerCommand("intentLoop.uninstallAgentAdapter", () =>
      uninstallAdapter(adapters),
    ),
    vscode.commands.registerCommand("intentLoop.exportReview", () => exportReview(controller)),
    vscode.commands.registerCommand("intentLoop.completeLoop", () => completeLoop(controller)),
    vscode.commands.registerCommand("intentLoop.openChangedDiff", (relativePath?: string) =>
      openChangedDiff(controller, relativePath),
    ),
    vscode.commands.registerCommand("intentLoop.reset", () => resetBaseline(controller)),
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
    placeHolder: "Intent Loop follows this plan instead of maintaining a separate intent",
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
  void vscode.window.showInformationMessage("Intent Loop follow-up prompt copied locally.");
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
      `Allow Intent Loop to run this local command in ${snapshot.state.repositoryRoot}?\n\n${definition.command}`,
      { modal: true },
      "Trust and Run",
    );
    if (choice !== "Trust and Run") return;
    await controller.trustVerification(name);
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Intent Loop: ${name}`,
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
    void vscode.window.showInformationMessage("No Intent Loop verification commands are configured.");
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
        "# Intent Loop runs only commands you explicitly trust in VS Code.",
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

async function exportReview(controller: ObservationController): Promise<void> {
  const snapshot = controller.getSnapshot();
  if (snapshot.kind !== "ready") return;
  const destination = await vscode.window.showSaveDialog({
    title: "Export local Intent Loop review",
    defaultUri: vscode.Uri.file(path.join(snapshot.state.repositoryRoot, "intent-loop-review.md")),
    filters: { Markdown: ["md"] },
  });
  if (!destination) return;
  await vscode.workspace.fs.writeFile(
    destination,
    Buffer.from(buildMarkdownReport(snapshot.state), "utf8"),
  );
  void vscode.window.showInformationMessage(`Intent Loop review exported to ${destination.fsPath}.`);
}

async function resetBaseline(controller: ObservationController): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    "Reset the Intent Loop baseline to the repository's current HEAD? Uncommitted changes will still appear.",
    { modal: true },
    "Reset to HEAD",
  );
  if (choice === "Reset to HEAD") await controller.reset();
}

async function openChangedDiff(
  controller: ObservationController,
  relativePath?: string,
): Promise<void> {
  if (!relativePath) return;
  const diff = await controller.getDiff(relativePath);
  const document = await vscode.workspace.openTextDocument({
    language: "diff",
    content: diff || `No diff is currently available for ${relativePath}.`,
  });
  await vscode.window.showTextDocument(document, { preview: true });
}

async function completeLoop(controller: ObservationController): Promise<void> {
  await controller.refresh();
  const snapshot = controller.getSnapshot();
  if (snapshot.kind !== "ready") return;

  if (!(await controller.isWorkingTreeClean())) {
    const choice = await vscode.window.showWarningMessage(
      "This loop still has uncommitted changes. Commit or revert them before advancing the baseline; Intent Loop will never commit automatically.",
      "Open Source Control",
    );
    if (choice === "Open Source Control") await vscode.commands.executeCommand("workbench.view.scm");
    return;
  }

  const readiness = calculateReadiness(snapshot.state.findings, snapshot.state.verification);
  const missing = missingRecommendedCategories(controller.getConfiguration().verification);
  const concerns = [...readiness.reasons];
  if (missing.length) concerns.push(`Recommended gates not configured: ${missing.join(", ")}`);
  const detail = concerns.length ? `\n\n${concerns.map((reason) => `• ${reason}`).join("\n")}` : "";
  const action = concerns.length ? "Finish Anyway" : "Finish Loop";
  const choice = await vscode.window.showWarningMessage(
    `Finish this loop and advance the baseline to the current HEAD?${detail}`,
    { modal: true },
    action,
  );
  if (choice !== action) return;

  await controller.reset();
  void vscode.window.showInformationMessage(
    "Previous loop completed. The current HEAD is now the baseline; Intent Loop will continue following the active plan document.",
  );
}

async function installAdapter(adapters: AdapterInstaller, agent: SupportedAgent): Promise<void> {
  const configPath = adapters.configPath(agent);
  const choice = await vscode.window.showWarningMessage(
    `Install the local Intent Loop ${agent} hook adapter? This will merge observer hooks into ${configPath}. Prompts and raw transcripts are not retained.`,
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
    void vscode.window.showInformationMessage(`Intent Loop ${agent} adapter installed.${suffix}`);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not install ${agent} adapter: ${String(error)}`);
  }
}

async function uninstallAdapter(adapters: AdapterInstaller): Promise<void> {
  const agent = await vscode.window.showQuickPick(["codex", "claude"] as const, {
    title: "Remove an Intent Loop agent adapter",
  });
  if (!agent) return;
  const selectedAgent = agent as SupportedAgent;
  const choice = await vscode.window.showWarningMessage(
    `Remove Intent Loop hook commands from ${adapters.configPath(selectedAgent)}? Other hooks will be preserved.`,
    { modal: true },
    "Remove Adapter",
  );
  if (choice !== "Remove Adapter") return;
  try {
    await adapters.uninstall(selectedAgent);
    void vscode.window.showInformationMessage(`Intent Loop ${selectedAgent} adapter removed.`);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not remove ${selectedAgent} adapter: ${String(error)}`);
  }
}

async function deleteData(
  controller: ObservationController,
  adapters: AdapterInstaller,
): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    "Delete this workspace's Intent Loop state and the local shared agent-event log? Agent hook configuration will remain installed.",
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
      `Intent Loop currently observes the first workspace folder: ${folders[0].name}.`,
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
