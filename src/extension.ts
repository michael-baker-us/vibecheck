import { access, mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import * as vscode from "vscode";

import { AdapterInstaller, SupportedAgent } from "./adapters/adapter-installer";
import { LocalEventReader } from "./adapters/local-event-reader";
import { AgentInstructionAlignmentService } from "./agent-instructions/alignment-service";
import { InstructionRefreshService } from "./agent-instructions/refresh-service";
import { AgentPermissionGrants } from "./providers/claude-cli";
import { RecommendationService } from "./config/recommendation-service";
import { buildAgentCapabilityTemplate, isAgentCapabilityTemplateId } from "./agent-instructions/capability-template";
import { AgentWorkspaceResetService } from "./agent-instructions/reset-service";
import { AnalysisEngine } from "./analyzers/analysis-engine";
import { AgentFileCollector } from "./collectors/agent-file-collector";
import { GitCollector } from "./collectors/git-collector";
import { PlanCollector } from "./collectors/plan-collector";
import { ConfigLoader } from "./config/config-loader";
import { ConfigurationSetupService } from "./config/configuration-setup-service";
import { CodeReviewFinding, CodeReviewSelection } from "./domain/code-review";
import { ChangeSummaryRange, ChangeSummarySession } from "./domain/change-summary";
import { ConfigurationSetupSession } from "./domain/configuration-setup";
import { InstructionFilePath, InstructionRefreshProposal, InstructionRefreshScope, InstructionRefreshSession } from "./domain/instruction-refresh";
import { ReadmeMaintenanceSession } from "./domain/readme-maintenance";
import { Finding } from "./domain/findings";
import { ObservationController } from "./observation-controller";
import { buildFollowUpPrompt } from "./prompts/follow-up-builder";
import { buildConfigurationSetupPrompt } from "./prompts/configuration-setup-builder";
import { buildInstructionRefreshPrompt } from "./prompts/instruction-refresh-builder";
import { DEFAULT_MODEL_ROUTING, MODEL_ROUTING_SETTINGS, ModelRouting, normalizeModelRouting } from "./providers/model-routing";
import { buildMarkdownReport } from "./reports/markdown-report";
import { buildCodeReviewMarkdown } from "./reports/code-review-markdown";
import { buildChangeSummaryMarkdown } from "./reports/change-summary-markdown";
import { buildVerificationReport } from "./reports/verification-markdown";
import { CodeReviewService } from "./reviews/code-review-service";
import { ReadmeMaintenanceService } from "./readme/readme-maintenance-service";
import { WorkspaceStore } from "./storage/workspace-store";
import { ChangeSummaryService } from "./summaries/change-summary-service";
import { FindingDiagnostics } from "./ui/diagnostics";
import { ControlCenterProvider } from "./ui/control-center";
import { VibeCheckStatusBar } from "./ui/status-bar";
import { INSTRUCTION_PREVIEW_SCHEME, InstructionPreviewProvider } from "./ui/instruction-preview-provider";
import { ProviderUsageService } from "./usage/provider-usage-service";
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
  const usageService = new ProviderUsageService();
  const changeSummaryService = new ChangeSummaryService();
  const readmeMaintenanceService = new ReadmeMaintenanceService();
  const alignmentService = new AgentInstructionAlignmentService();
  const agentWorkspaceResetService = new AgentWorkspaceResetService();
  const instructionPreviewProvider = new InstructionPreviewProvider();
  let changeSummarySession: ChangeSummarySession | undefined;
  let readmeMaintenanceSession: ReadmeMaintenanceSession | undefined;
  let configurationSetupSession: ConfigurationSetupSession | undefined;
  let instructionRefreshSession: InstructionRefreshSession | undefined;
  let instructionRefreshProposal: InstructionRefreshProposal | undefined;
  let providerUsage = usageService.emptySnapshot();
  let agentAlignment = alignmentService.emptySnapshot();
  const adapters = new AdapterInstaller(context.asAbsolutePath("resources/hook-bridge.cjs"));
  const statusBar = new VibeCheckStatusBar();
  const diagnostics = new FindingDiagnostics();
  let controller: ObservationController;
  /**
   * Permissions resolved when a provider session starts. A non-interactive Claude run cannot ask
   * for approval, so anything not granted here fails outright instead of prompting. Verification
   * commands are included by default because they are repository-owned and already trusted.
   */
  const agentGrants = (): AgentPermissionGrants => {
    const settings = vscode.workspace.getConfiguration(
      "vibecheck",
      vscode.workspace.workspaceFolders?.[0]?.uri,
    );
    return {
      commands: settings.get<string[]>("agentAllowedCommands", []),
      verificationCommands: settings.get<boolean>("agentMayRunVerificationCommands", true)
        ? controller.getConfiguration().verification.map((definition) => definition.command)
        : [],
    };
  };
  const configurationSetupService = new ConfigurationSetupService(undefined, undefined, agentGrants);
  const instructionRefreshService = new InstructionRefreshService(undefined, agentGrants);
  let refreshAgentAlignment: () => Promise<void> = async () => undefined;
  const controlCenter = new ControlCenterProvider(
    () => controller.getSnapshot(),
    () => controller.getConfiguration(),
    () => controller.getConfigurationError(),
    () => controller.getReviewTranscript(),
    () => changeSummarySession,
    () => readmeMaintenanceSession,
    () => configurationSetupSession,
    () => instructionRefreshSession,
    () => providerUsage,
    () => agentAlignment,
    extensionVersion(context),
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
    new CodeReviewService(),
    () => {
      const snapshot = controller.getSnapshot();
      controlCenter.refresh();
      statusBar.render(snapshot);
      diagnostics.render(snapshot);
      void refreshAgentAlignment();
    },
    output,
  );
  refreshAgentAlignment = async () => {
    const snapshot = controller.getSnapshot();
    if (snapshot.kind !== "ready") return;
    agentAlignment = await alignmentService.scan(snapshot.state.repositoryRoot, snapshot.state.activePlan?.path);
    controlCenter.refresh();
  };
  const eventReader = new LocalEventReader(
    (event) => void controller.ingestAgentEvent(event),
    output,
  );

  context.subscriptions.push(
    statusBar,
    diagnostics,
    controller,
    eventReader,
    instructionPreviewProvider,
    vscode.workspace.registerTextDocumentContentProvider(INSTRUCTION_PREVIEW_SCHEME, instructionPreviewProvider),
    vscode.window.registerWebviewViewProvider("vibecheck.overview", controlCenter, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("vibecheck.start", () => controller.resume()),
    vscode.commands.registerCommand("vibecheck.pause", () => controller.pause()),
    vscode.commands.registerCommand("vibecheck.refresh", () => controller.refresh()),
    vscode.commands.registerCommand("vibecheck.refreshProviderUsage", async () => {
      providerUsage = usageService.loadingSnapshot(providerUsage);
      controlCenter.refresh();
      providerUsage = await usageService.collect();
      controlCenter.refresh();
    }),
    vscode.commands.registerCommand("vibecheck.selectPlan", () => selectPlan(controller)),
    vscode.commands.registerCommand("vibecheck.openPlan", () => openPlan(controller)),
    vscode.commands.registerCommand("vibecheck.inspectFinding", (argument?: Finding) =>
      withFinding(argument, (finding) => inspectFinding(controller, finding)),
    ),
    vscode.commands.registerCommand("vibecheck.acceptFinding", (argument?: Finding) =>
      withFinding(argument, (finding) => controller.setFindingStatus(finding.id, "accepted")),
    ),
    vscode.commands.registerCommand("vibecheck.dismissFinding", (argument?: Finding) =>
      withFinding(argument, (finding) => controller.setFindingStatus(finding.id, "dismissed")),
    ),
    vscode.commands.registerCommand("vibecheck.reopenFinding", (argument?: Finding) =>
      withFinding(argument, (finding) => controller.setFindingStatus(finding.id, "open")),
    ),
    vscode.commands.registerCommand("vibecheck.copyPrompt", (argument?: Finding) =>
      copyPrompt(controller, argument),
    ),
    vscode.commands.registerCommand("vibecheck.runVerification", (argument?: string) =>
      runVerificationCommand(controller, argument),
    ),
    vscode.commands.registerCommand("vibecheck.runAllVerification", async () => {
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
    vscode.commands.registerCommand("vibecheck.runCodeReview", () => runCodeReview(controller)),
    vscode.commands.registerCommand("vibecheck.clearCodeReview", () => clearCodeReview(controller)),
    vscode.commands.registerCommand("vibecheck.inspectCodeReviewFinding", (findingId?: string) =>
      inspectCodeReviewFinding(controller, findingId),
    ),
    vscode.commands.registerCommand("vibecheck.previewCodeReview", () => previewCodeReview(controller)),
    vscode.commands.registerCommand("vibecheck.summarizeChanges", (options?: unknown) =>
      summarizeChanges(controller, git, changeSummaryService, (session) => {
        changeSummarySession = session;
        controlCenter.refresh();
      }, options)),
    vscode.commands.registerCommand("vibecheck.maintainReadme", () =>
      maintainReadme(controller, readmeMaintenanceService, (session) => {
        readmeMaintenanceSession = session;
        controlCenter.refresh();
      })),
    vscode.commands.registerCommand("vibecheck.showVerificationOutput", async (argument?: string) => {
      const name = argument ?? (await chooseVerification(controller, "Select verification output"));
      if (!name) return;
      const snapshot = controller.getSnapshot();
      if (snapshot.kind !== "ready") return;
      const verification = snapshot.state.verification.find((item) => item.name === name);
      if (!verification) {
        void vscode.window.showInformationMessage(`No quality gate named “${name}” is available.`);
        return;
      }
      const document = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: buildVerificationReport(verification),
      });
      await vscode.window.showTextDocument(document, { preview: true });
      await vscode.commands.executeCommand("markdown.showPreview", document.uri);
    }),
    vscode.commands.registerCommand("vibecheck.openConfig", () => openConfiguration(controller)),
    vscode.commands.registerCommand("vibecheck.createSetupPrompt", () =>
      runConfigurationSetup(controller, configurationSetupService, (session) => {
        configurationSetupSession = session;
        controlCenter.refresh();
      })),
    vscode.commands.registerCommand("vibecheck.manageAgentFile", (relativePath?: string) =>
      manageAgentFile(controller, relativePath),
    ),
    vscode.commands.registerCommand("vibecheck.generateAgentInstructions", () =>
      refreshAgentInstructions(controller, instructionRefreshService, instructionPreviewProvider, "instructions", (session, proposal) => {
        instructionRefreshSession = session;
        instructionRefreshProposal = proposal;
        controlCenter.refresh();
      })),
    vscode.commands.registerCommand("vibecheck.clearAgentWorkspace", async () => {
      const snapshot = controller.getSnapshot();
      if (snapshot.kind !== "ready") return;
      const knownFiles = snapshot.state.agentFiles
        .filter((file) => file.exists && (file.owner === "codex" || file.owner === "claude"))
        .map((file) => file.path);
      const files = await agentWorkspaceResetService.discover(snapshot.state.repositoryRoot, knownFiles);
      if (!files.length) {
        void vscode.window.showInformationMessage("No Codex or Claude repository workspace files are present.");
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Remove all ${files.length} discovered Codex and Claude repository workspace files? VibeCheck configuration and the active plan will remain.`,
        { modal: true, detail: `A recoverable backup will be created outside the repository before removal.\n\n${files.join("\n")}` },
        "Back Up and Remove Files",
      );
      if (choice !== "Back Up and Remove Files") return;
      try {
        await vscode.workspace.getConfiguration("vibecheck", workspaceFolder.uri).update(
          "alignAgentWorkspace",
          false,
          vscode.ConfigurationTarget.Workspace,
        );
        const result = await agentWorkspaceResetService.reset(
          snapshot.state.repositoryRoot,
          files,
          path.join(context.globalStorageUri.fsPath, "workspace-reset-backups"),
        );
        instructionRefreshSession = undefined;
        instructionRefreshProposal = undefined;
        instructionPreviewProvider.setProposal(undefined);
        await controller.refresh();
        await refreshAgentAlignment();
        void vscode.window.showInformationMessage(
          `Removed ${result.removedFiles.length} Agent Workspace file${result.removedFiles.length === 1 ? "" : "s"}. Backup: ${result.backupDirectory}`,
        );
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not clear the Agent Workspace: ${String(error)}`);
      }
    }),
    vscode.commands.registerCommand("vibecheck.refreshAgentInstructions", () =>
      refreshAgentInstructions(controller, instructionRefreshService, instructionPreviewProvider, "supporting", (session, proposal) => {
        instructionRefreshSession = session;
        instructionRefreshProposal = proposal;
        controlCenter.refresh();
      })),
    vscode.commands.registerCommand("vibecheck.openAgentCapabilityTemplate", async (templateId?: unknown) => {
      if (!isAgentCapabilityTemplateId(templateId)) return;
      const document = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: buildAgentCapabilityTemplate(templateId),
      });
      await vscode.window.showTextDocument(document, { preview: false });
    }),
    vscode.commands.registerCommand("vibecheck.previewAgentInstruction", (file?: InstructionFilePath) =>
      previewAgentInstruction(instructionPreviewProvider, instructionRefreshProposal, file)),
    vscode.commands.registerCommand("vibecheck.applyAgentInstructionRefresh", () =>
      applyAgentInstructionRefresh(
        controller,
        instructionRefreshService,
        instructionPreviewProvider,
        instructionRefreshSession,
        instructionRefreshProposal,
        path.join(context.globalStorageUri.fsPath, "instruction-backups"),
        refreshAgentAlignment,
        (session, proposal) => {
          instructionRefreshSession = session;
          instructionRefreshProposal = proposal;
          controlCenter.refresh();
        },
      )),
    vscode.commands.registerCommand("vibecheck.discardAgentInstructionRefresh", () => {
      if (!instructionRefreshSession || instructionRefreshSession.status !== "preview") return;
      instructionRefreshSession = { ...instructionRefreshSession, status: "discarded", finishedAt: new Date().toISOString() };
      instructionRefreshProposal = undefined;
      instructionPreviewProvider.setProposal(undefined);
      controlCenter.refresh();
    }),
    vscode.commands.registerCommand("vibecheck.alignAgentInstructions", () =>
      alignAgentWorkspace(controller, alignmentService, refreshAgentAlignment, true),
    ),
    vscode.commands.registerCommand("vibecheck.resolveAgentAlignment", async (selection?: string) => {
      const match = /^skills:([^|]+)\|(codex|claude)$/.exec(selection ?? "");
      if (!match) return;
      const name = match[1];
      const source = match[2] as "codex" | "claude";
      const choice = await vscode.window.showWarningMessage(
        `Use the ${source === "codex" ? "Codex" : "Claude"} copy of skill '${name}' for both providers? The replaced copy will be backed up outside the repository.`,
        { modal: true },
        "Align Skill",
      );
      if (choice !== "Align Skill") return;
      try {
        const snapshot = controller.getSnapshot();
        if (snapshot.kind !== "ready") return;
        const result = await alignmentService.alignSkill(
          snapshot.state.repositoryRoot,
          name,
          source,
          path.join(context.globalStorageUri.fsPath, "alignment-backups"),
        );
        await controller.refresh();
        await refreshAgentAlignment();
        void vscode.window.showInformationMessage(`Aligned '${name}' from ${source}. ${result.backupPath ? `Previous copy backed up to ${result.backupPath}.` : ""}`);
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not align skill '${name}': ${String(error)}`);
      }
    }),
    vscode.commands.registerCommand("vibecheck.applyGateRecommendation", async (id?: string) => {
      const snapshot = controller.getSnapshot();
      if (snapshot.kind !== "ready" || typeof id !== "string") return;
      const recommendation = controller.getConfiguration().recommendations.find((item) => item.id === id);
      if (!recommendation) return;

      const service = new RecommendationService();
      let plan;
      try {
        plan = await service.plan(snapshot.state.repositoryRoot, recommendation);
      } catch (error) {
        void vscode.window.showErrorMessage((error as Error).message);
        return;
      }

      // The exact argument vector is shown before anything runs; this is a dependency change.
      const choice = await vscode.window.showWarningMessage(
        `Install ${recommendation.packages.join(", ")} with ${plan.manager.label}?`,
        {
          modal: true,
          detail: `Runs: ${plan.argv.join(" ")}\n\nOn success VibeCheck adds the "${recommendation.gate.name}" gate to .vibecheck/config.yaml running: ${recommendation.gate.command}`,
        },
        "Install and Add Gate",
      );
      if (choice !== "Install and Add Gate") return;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Installing ${recommendation.packages.join(", ")}`, cancellable: true },
        async (_progress, token) => {
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());
          try {
            const outcome = await service.apply(snapshot.state.repositoryRoot, recommendation, abort.signal);
            await controller.refresh();
            controlCenter.refresh();
            void vscode.window.showInformationMessage(`Added the "${outcome.gateName}" gate. Run it to collect evidence.`);
          } catch (error) {
            void vscode.window.showErrorMessage((error as Error).message);
          }
        },
      );
    }),
    vscode.commands.registerCommand("vibecheck.setAgentAlignment", async (enabled?: boolean) => {
      if (typeof enabled !== "boolean") return;
      await vscode.workspace.getConfiguration("vibecheck", workspaceFolder.uri).update(
        "alignAgentWorkspace",
        enabled,
        vscode.ConfigurationTarget.Workspace,
      );
      if (enabled) await alignAgentWorkspace(controller, alignmentService, refreshAgentAlignment, true);
      controlCenter.refresh();
    }),
    vscode.commands.registerCommand("vibecheck.setModelRouting", async (value?: unknown) => {
      if (!isPlainRecord(value)) return;
      const routing = normalizeModelRouting({
        codexBalanced: typeof value.codexBalanced === "string" ? value.codexBalanced : undefined,
        codexDeep: typeof value.codexDeep === "string" ? value.codexDeep : undefined,
        claudeBalanced: typeof value.claudeBalanced === "string" ? value.claudeBalanced : undefined,
        claudeDeep: typeof value.claudeDeep === "string" ? value.claudeDeep : undefined,
      });
      const configuration = vscode.workspace.getConfiguration("vibecheck", workspaceFolder.uri);
      await Promise.all((Object.keys(MODEL_ROUTING_SETTINGS) as Array<keyof ModelRouting>).map((key) =>
        configuration.update(MODEL_ROUTING_SETTINGS[key], routing[key], vscode.ConfigurationTarget.Workspace),
      ));
      controlCenter.refresh();
      void vscode.window.showInformationMessage("Saved Balanced and Deep model routes for Claude and Codex.");
    }),
    vscode.commands.registerCommand("vibecheck.installCodexAdapter", () =>
      installAdapter(adapters, "codex"),
    ),
    vscode.commands.registerCommand("vibecheck.installClaudeAdapter", () =>
      installAdapter(adapters, "claude"),
    ),
    vscode.commands.registerCommand("vibecheck.uninstallAgentAdapter", () =>
      uninstallAdapter(adapters),
    ),
    vscode.commands.registerCommand("vibecheck.createReport", () => createEvidenceReport(controller)),
    vscode.commands.registerCommand("vibecheck.deleteData", () => deleteData(controller, adapters)),
  );

  statusBar.render(controller.getSnapshot());
  await controller.initialize();
  const instructionWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceFolder, "{AGENTS.md,CLAUDE.md,.mcp.json,.agents/**,.codex/**,.claude/**}"),
  );
  const alignWhenEnabled = async (): Promise<void> => {
    if (vscode.workspace.getConfiguration("vibecheck", workspaceFolder.uri).get<boolean>("alignAgentWorkspace", false)) {
      await alignAgentWorkspace(controller, alignmentService, refreshAgentAlignment, false);
      return;
    }
    await refreshAgentAlignment();
  };
  context.subscriptions.push(
    instructionWatcher,
    instructionWatcher.onDidCreate(() => void alignWhenEnabled()),
    instructionWatcher.onDidChange(() => void alignWhenEnabled()),
    instructionWatcher.onDidDelete(() => void alignWhenEnabled()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("vibecheck.alignAgentWorkspace", workspaceFolder.uri)) {
        void alignWhenEnabled();
        controlCenter.refresh();
      }
      if ((Object.values(MODEL_ROUTING_SETTINGS)).some((key) => event.affectsConfiguration(`vibecheck.${key}`, workspaceFolder.uri))) {
        controlCenter.refresh();
      }
    }),
  );
  await refreshAgentAlignment();
  await alignWhenEnabled();
  void vscode.commands.executeCommand("vibecheck.refreshProviderUsage");
  eventReader.start();
}

/** Reads the running extension version from its own manifest. */
function extensionVersion(context: vscode.ExtensionContext): string {
  const version = (context.extension?.packageJSON as { version?: unknown } | undefined)?.version;
  return typeof version === "string" ? version : "unknown";
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
  if (!definition?.exists) return;
  if (relativePath === ".vibecheck/config.yaml") {
    await openConfiguration(controller);
    return;
  }

  const absolutePath = path.resolve(snapshot.state.repositoryRoot, relativePath);
  const relative = path.relative(snapshot.state.repositoryRoot, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return;
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(absolutePath));
}

async function alignAgentWorkspace(
  controller: ObservationController,
  service: AgentInstructionAlignmentService,
  refreshAlignment: () => Promise<void>,
  notify: boolean,
): Promise<void> {
  const snapshot = controller.getSnapshot();
  if (snapshot.kind !== "ready") return;
  try {
    const result = await service.alignSafe(snapshot.state.repositoryRoot);
    if (result.instructionsChanged || result.skillsCopiedToClaude || result.skillsCopiedToCodex) await controller.refresh();
    await refreshAlignment();
    if (!notify) return;
    const changes = [
      result.instructionsChanged ? "shared instructions" : "",
      result.skillsCopiedToClaude ? `${result.skillsCopiedToClaude} skill${result.skillsCopiedToClaude === 1 ? "" : "s"} copied to Claude` : "",
      result.skillsCopiedToCodex ? `${result.skillsCopiedToCodex} skill${result.skillsCopiedToCodex === 1 ? "" : "s"} copied to Codex` : "",
    ].filter(Boolean);
    const suffix = result.reviewRequired ? ` ${result.reviewRequired} provider-specific or conflicting item${result.reviewRequired === 1 ? "" : "s"} still need review.` : "";
    void vscode.window.showInformationMessage(`${changes.length ? `Aligned ${changes.join(", ")}.` : "Safe portable files are already aligned."}${suffix}`);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not align Claude and Codex guidance: ${String(error)}`);
  }
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

async function runCodeReview(controller: ObservationController): Promise<void> {
  const snapshot = controller.getSnapshot();
  if (snapshot.kind !== "ready") return;
  if (!snapshot.state.changedFiles.length) {
    void vscode.window.showInformationMessage("There are no uncommitted changes to review.");
    return;
  }
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage("Trust this VS Code workspace before invoking a review provider.");
    return;
  }
  const choice = await chooseProviderModel("Choose code review provider and model", "review");
  if (!choice) return;
  const selection: CodeReviewSelection = choice;
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `VibeCheck: ${choice.label} code review`,
        cancellable: true,
      },
      async (_progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        await controller.runCodeReview(selection, abort.signal);
      },
    );
    const current = controller.getSnapshot();
    const count = current.kind === "ready" ? current.state.codeReview?.findings.length ?? 0 : 0;
    void vscode.window.showInformationMessage(`${choice.label} review completed with ${count} finding${count === 1 ? "" : "s"}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`${choice.label} review failed: ${message}`);
  }
}

async function summarizeChanges(
  controller: ObservationController,
  git: GitCollector,
  service: ChangeSummaryService,
  onSessionChanged: (session: ChangeSummarySession) => void,
  options?: unknown,
): Promise<void> {
  const snapshot = controller.getSnapshot();
  if (snapshot.kind !== "ready") return;
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage("Trust this VS Code workspace before invoking a summary provider.");
    return;
  }

  const configured = parseChangeSummaryOptions(options);
  if (configured) {
    await summarizeConfiguredChanges(snapshot.state.repositoryRoot, snapshot.state.baselineCommit, snapshot.state.headBranch, git, service, onSessionChanged, configured);
    return;
  }

  const scope = await vscode.window.showQuickPick([
    {
      label: "Current branch changes",
      description: "Compare the branch point with HEAD",
      detail: "Useful when preparing a merge request or pull request.",
      scope: "branch" as const,
    },
    {
      label: "Two commits or refs",
      description: "Choose both sides of the comparison",
      detail: "Accepts commit hashes, tags, and branch names.",
      scope: "revisions" as const,
    },
  ], { title: "Create a Markdown change summary", placeHolder: "Choose what to summarize" });
  if (!scope) return;

  let baseLabel: string;
  let targetLabel: string;
  if (scope.scope === "branch") {
    const input = await vscode.window.showInputBox({
      title: "Base branch or ref",
      prompt: "The shared ancestor with this ref will be compared with HEAD.",
      placeHolder: "main",
      value: "main",
      ignoreFocusOut: true,
    });
    if (!input) return;
    try {
      const baseRef = await git.resolveCommit(snapshot.state.repositoryRoot, input);
      baseLabel = `${input.trim()} (merge base)`;
      targetLabel = "HEAD";
      const mergeBase = await git.mergeBase(snapshot.state.repositoryRoot, baseRef, snapshot.state.baselineCommit);
      await createChangeSummary(service, snapshot.state.repositoryRoot, {
        scope: "commits",
        base: mergeBase,
        target: snapshot.state.baselineCommit,
        baseLabel,
        targetLabel,
      }, undefined, onSessionChanged);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  const baseInput = await vscode.window.showInputBox({
    title: "Base commit or ref",
    prompt: "Choose the older side of the comparison.",
    placeHolder: "main, a tag, or a commit hash",
    ignoreFocusOut: true,
  });
  if (!baseInput) return;
  const targetInput = await vscode.window.showInputBox({
    title: "Target commit or ref",
    prompt: "Choose the newer side of the comparison.",
    value: "HEAD",
    ignoreFocusOut: true,
  });
  if (!targetInput) return;
  try {
    const [base, target] = await Promise.all([
      git.resolveCommit(snapshot.state.repositoryRoot, baseInput),
      git.resolveCommit(snapshot.state.repositoryRoot, targetInput),
    ]);
    await createChangeSummary(service, snapshot.state.repositoryRoot, {
      scope: "commits", base, target, baseLabel: baseInput.trim(), targetLabel: targetInput.trim(),
    }, undefined, onSessionChanged);
  } catch (error) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

type ChangeSummaryOptions = {
  mode: "working-tree" | "branches" | "commits";
  source?: string;
  target?: string;
  remote?: string;
  fetchLatest: boolean;
  model: "codex-balanced" | "codex-deep" | "claude-balanced" | "claude-deep";
};

async function summarizeConfiguredChanges(
  repositoryRoot: string,
  head: string,
  headBranch: string | undefined,
  git: GitCollector,
  service: ChangeSummaryService,
  onSessionChanged: (session: ChangeSummarySession) => void,
  options: ChangeSummaryOptions,
): Promise<void> {
  const selection = summaryModelSelection(options.model);
  try {
    if (options.mode === "working-tree") {
      if (await git.isWorkingTreeClean(repositoryRoot)) {
        void vscode.window.showInformationMessage("There are no working-tree changes to summarize.");
        return;
      }
      await createChangeSummary(service, repositoryRoot, {
        scope: "working-tree",
        base: head,
        target: head,
        baseLabel: "HEAD",
        targetLabel: "working tree",
      }, selection, onSessionChanged);
      return;
    }

    if (!options.source?.trim() || !options.target?.trim()) {
      throw new Error(options.mode === "branches" ? "Enter both source and target branches." : "Enter both commit hashes or refs.");
    }
    const sourceLabel = options.source.trim();
    const targetLabel = options.target.trim();
    const source = await git.resolveCommit(repositoryRoot, sourceLabel);
    let target: string;
    let resolvedTargetLabel = targetLabel;
    if (options.mode === "branches" && options.fetchLatest) {
      const remote = options.remote?.trim() || "origin";
      target = await git.fetchBranch(repositoryRoot, remote, targetLabel);
      resolvedTargetLabel = `${remote}/${targetLabel}`;
    } else {
      target = await git.resolveCommit(repositoryRoot, targetLabel);
    }
    const base = options.mode === "branches" ? await git.mergeBase(repositoryRoot, target, source) : source;
    const comparisonTarget = options.mode === "branches" ? source : target;
    if (!await git.hasChangesBetween(repositoryRoot, base, comparisonTarget)) {
      void vscode.window.showInformationMessage("The selected revisions have no changes to summarize.");
      return;
    }
    await createChangeSummary(service, repositoryRoot, {
      scope: "commits",
      base,
      target: comparisonTarget,
      baseLabel: options.mode === "branches" ? `${resolvedTargetLabel} (merge base)` : sourceLabel,
      targetLabel: options.mode === "branches" ? (sourceLabel || headBranch || "HEAD") : targetLabel,
    }, selection, onSessionChanged);
  } catch (error) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

function parseChangeSummaryOptions(value: unknown): ChangeSummaryOptions | undefined {
  if (!isPlainRecord(value)) return undefined;
  const modes = ["working-tree", "branches", "commits"];
  const models = ["codex-balanced", "codex-deep", "claude-balanced", "claude-deep"];
  if (typeof value.mode !== "string" || !modes.includes(value.mode) || typeof value.model !== "string" || !models.includes(value.model)) return undefined;
  return {
    mode: value.mode as ChangeSummaryOptions["mode"],
    source: typeof value.source === "string" ? value.source : undefined,
    target: typeof value.target === "string" ? value.target : undefined,
    remote: typeof value.remote === "string" ? value.remote : undefined,
    fetchLatest: value.fetchLatest === true,
    model: value.model as ChangeSummaryOptions["model"],
  };
}

function summaryModelSelection(model: ChangeSummaryOptions["model"]): ProviderModelChoice {
  return providerModelChoices("summary").find((choice) => choice.key === model) ?? providerModelChoices("summary")[0];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function createChangeSummary(
  service: ChangeSummaryService,
  repositoryRoot: string,
  range: ChangeSummaryRange,
  requestedSelection?: ProviderModelChoice,
  onSessionChanged?: (session: ChangeSummarySession) => void,
): Promise<void> {
  const choice = requestedSelection ?? await chooseProviderModel("Choose change-summary provider and model", "summary");
  if (!choice) return;
  const startedAt = new Date().toISOString();
  let session: ChangeSummarySession = {
    ...range,
    ...choice,
    status: "running",
    startedAt,
    transcript: [{ at: startedAt, kind: "status", label: `Starting ${choice.provider === "codex" ? "Codex" : "Claude"} summary` }],
  };
  const updateSession = (change: Partial<ChangeSummarySession>) => {
    session = { ...session, ...change };
    onSessionChanged?.(session);
  };
  updateSession({});
  try {
    const summary = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `VibeCheck: Summarizing ${range.baseLabel} to ${range.targetLabel}`, cancellable: true },
      async (progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        progress.report({ message: `Starting ${choice.provider === "codex" ? "Codex" : "Claude"} CLI…` });
        return service.run({ ...range, ...choice }, repositoryRoot, abort.signal, (event) => {
          progress.report({ message: event.detail ? `${event.label} · ${event.detail}` : event.label });
        }, (entry) => {
          const previous = session.transcript.at(-1);
          if (previous?.kind === entry.kind && previous.label === entry.label && previous.content === entry.content) return;
          updateSession({ transcript: [...session.transcript, { ...entry, at: new Date().toISOString() }].slice(-100) });
        });
      },
    );
    updateSession({ status: "completed", finishedAt: new Date().toISOString() });
    const document = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: buildChangeSummaryMarkdown(summary, range, choice),
    });
    await vscode.window.showTextDocument(document, { preview: false });
  } catch (error) {
    updateSession({
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    void vscode.window.showErrorMessage(`Change summary failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function maintainReadme(
  controller: ObservationController,
  service: ReadmeMaintenanceService,
  onSessionChanged: (session: ReadmeMaintenanceSession) => void,
): Promise<void> {
  const snapshot = controller.getSnapshot();
  if (snapshot.kind !== "ready") return;
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage("Trust this VS Code workspace before invoking a README provider.");
    return;
  }
  const choice = await chooseProviderModel("Choose README provider and model", "readme");
  if (!choice) return;
  const startedAt = new Date().toISOString();
  let session: ReadmeMaintenanceSession = {
    ...choice,
    headCommit: snapshot.state.baselineCommit,
    status: "running",
    startedAt,
    transcript: [{ at: startedAt, kind: "status", label: `Starting ${choice.provider === "codex" ? "Codex" : "Claude"} README review` }],
  };
  const updateSession = (change: Partial<ReadmeMaintenanceSession>) => {
    session = { ...session, ...change };
    onSessionChanged(session);
  };
  updateSession({});
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "VibeCheck: Maintaining README.md", cancellable: true },
      async (progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        progress.report({ message: `Starting ${choice.provider === "codex" ? "Codex" : "Claude"} CLI…` });
        return service.run(choice, snapshot.state.repositoryRoot, abort.signal, (event) => {
          progress.report({ message: event.detail ? `${event.label} · ${event.detail}` : event.label });
        }, (entry) => {
          const previous = session.transcript.at(-1);
          if (previous?.kind === entry.kind && previous.label === entry.label && previous.content === entry.content) return;
          updateSession({ transcript: [...session.transcript, { ...entry, at: new Date().toISOString() }].slice(-100) });
        });
      },
    );
    updateSession({
      status: "completed",
      finishedAt: new Date().toISOString(),
      mode: result.mode,
      baseCommit: result.baseCommit,
      headCommit: result.headCommit,
      summary: result.summary,
    });
    await controller.refresh();
    const document = await vscode.workspace.openTextDocument(path.join(snapshot.state.repositoryRoot, "README.md"));
    await vscode.window.showTextDocument(document, { preview: false });
    void vscode.window.showInformationMessage(`README.md updated with a ${result.mode === "full" ? "whole-repository" : "Git-history"} review.`);
  } catch (error) {
    updateSession({
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    void vscode.window.showErrorMessage(`README update failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type ProviderModelChoice = CodeReviewSelection & vscode.QuickPickItem & { label: string; key: ChangeSummaryOptions["model"] };

async function chooseProviderModel(
  title: string,
  purpose: "review" | "summary" | "setup" | "instructions" | "readme",
): Promise<ProviderModelChoice | undefined> {
  return vscode.window.showQuickPick<ProviderModelChoice>(
    providerModelChoices(purpose),
    {
      title,
      placeHolder: "The selected provider, exact model, and effort will be passed to its CLI",
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
}

function providerModelChoices(purpose: "review" | "summary" | "setup" | "instructions" | "readme"): ProviderModelChoice[] {
  const routing = getModelRouting();
  const balancedDetail = purpose === "summary"
    ? "Recommended for concise summaries with lower latency and cost."
    : purpose === "readme"
      ? "Recommended for routine README generation and maintenance."
    : purpose === "setup"
      ? "Recommended for routine repository inspection and configuration updates."
      : purpose === "instructions"
        ? "Recommended for routine repository instruction audits."
      : "Faster routine review with balanced capability and latency.";
  const deepDetail = purpose === "summary"
    ? "Higher-cost option for unusually large or complex comparisons."
    : purpose === "readme"
      ? "Quality-first README review for large or complex repositories."
    : purpose === "setup"
      ? "Quality-first configuration for large repositories or complex build systems."
      : purpose === "instructions"
        ? "Quality-first instruction audit for large repositories or complex architecture."
      : "Quality-first review for large, sensitive, or difficult changes.";
  return [
    { key: "codex-balanced", label: "Codex · Balanced (Default)", description: `${routing.codexBalanced} · medium effort`, detail: balancedDetail, provider: "codex", profile: "balanced", model: routing.codexBalanced, effort: "medium" },
    { key: "codex-deep", label: "Codex · Deep", description: `${routing.codexDeep} · high effort`, detail: deepDetail, provider: "codex", profile: "deep", model: routing.codexDeep, effort: "high" },
    { key: "claude-balanced", label: "Claude · Balanced (Default)", description: `${routing.claudeBalanced} · medium effort`, detail: balancedDetail, provider: "claude", profile: "balanced", model: routing.claudeBalanced, effort: "medium" },
    { key: "claude-deep", label: "Claude · Deep", description: `${routing.claudeDeep} · high effort`, detail: deepDetail, provider: "claude", profile: "deep", model: routing.claudeDeep, effort: "high" },
  ];
}

function getModelRouting(): ModelRouting {
  const configuration = vscode.workspace.getConfiguration("vibecheck", vscode.workspace.workspaceFolders?.[0]?.uri);
  return normalizeModelRouting({
    codexBalanced: configuration.get<string>(MODEL_ROUTING_SETTINGS.codexBalanced, DEFAULT_MODEL_ROUTING.codexBalanced),
    codexDeep: configuration.get<string>(MODEL_ROUTING_SETTINGS.codexDeep, DEFAULT_MODEL_ROUTING.codexDeep),
    claudeBalanced: configuration.get<string>(MODEL_ROUTING_SETTINGS.claudeBalanced, DEFAULT_MODEL_ROUTING.claudeBalanced),
    claudeDeep: configuration.get<string>(MODEL_ROUTING_SETTINGS.claudeDeep, DEFAULT_MODEL_ROUTING.claudeDeep),
  });
}

async function inspectCodeReviewFinding(
  controller: ObservationController,
  findingId?: string,
): Promise<void> {
  const snapshot = controller.getSnapshot();
  if (snapshot.kind !== "ready" || !findingId) return;
  const finding = snapshot.state.codeReview?.findings.find((item) => item.id === findingId);
  if (!finding) return;
  await openCodeReviewEvidence(snapshot.state.repositoryRoot, finding);
}

async function clearCodeReview(controller: ObservationController): Promise<void> {
  const snapshot = controller.getSnapshot();
  if (snapshot.kind !== "ready" || !snapshot.state.codeReview) {
    void vscode.window.showInformationMessage("There is no code review to clear.");
    return;
  }
  if (snapshot.state.codeReview.status === "running") {
    void vscode.window.showInformationMessage("Wait for the current code review to finish before clearing it.");
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    "Clear the current code review and its in-memory CLI transcript?",
    { modal: true },
    "Clear Review",
  );
  if (choice !== "Clear Review") return;

  if (await controller.clearCodeReview()) {
    void vscode.window.showInformationMessage("Current code review cleared.");
  }
}

async function previewCodeReview(controller: ObservationController): Promise<void> {
  const snapshot = controller.getSnapshot();
  if (snapshot.kind !== "ready" || !snapshot.state.codeReview) {
    void vscode.window.showInformationMessage("Run a code review before opening its Markdown report.");
    return;
  }
  const document = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: buildCodeReviewMarkdown(snapshot.state.codeReview, { branch: snapshot.state.headBranch }),
  });
  await vscode.window.showTextDocument(document, { preview: true });
  await vscode.commands.executeCommand("markdown.showPreview", document.uri);
}

async function openCodeReviewEvidence(repositoryRoot: string, finding: CodeReviewFinding): Promise<void> {
  if (finding.path) {
    const absolutePath = path.resolve(repositoryRoot, finding.path);
    const relative = path.relative(repositoryRoot, absolutePath);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      try {
        const document = await vscode.workspace.openTextDocument(absolutePath);
        const editor = await vscode.window.showTextDocument(document);
        if (finding.line) {
          const start = new vscode.Position(Math.max(0, finding.line - 1), 0);
          const end = new vscode.Position(Math.max(0, (finding.endLine ?? finding.line) - 1), 0);
          editor.selection = new vscode.Selection(start, end);
          editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
        }
        return;
      } catch {
        // Fall through to a review detail document when the referenced file is unavailable.
      }
    }
  }
  const document = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: `# ${finding.title}\n\n${finding.explanation}`,
  });
  await vscode.window.showTextDocument(document, { preview: true });
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
  const directory = path.join(snapshot.state.repositoryRoot, ".vibecheck");
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

async function runConfigurationSetup(
  controller: ObservationController,
  service: ConfigurationSetupService,
  onSessionChanged: (session: ConfigurationSetupSession) => void,
): Promise<void> {
  const snapshot = controller.getSnapshot();
  if (snapshot.kind !== "ready") return;
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage("Trust this VS Code workspace before invoking a configuration provider.");
    return;
  }
  const configPath = path.join(snapshot.state.repositoryRoot, ".vibecheck", "config.yaml");
  let existingConfig = true;
  try {
    await access(configPath);
  } catch {
    existingConfig = false;
  }
  const choice = await chooseProviderModel(
    existingConfig ? "Choose model to audit VibeCheck configuration" : "Choose model to set up VibeCheck",
    "setup",
  );
  if (!choice) return;
  const prompt = buildConfigurationSetupPrompt(controller.getConfiguration(), existingConfig);
  const startedAt = new Date().toISOString();
  let session: ConfigurationSetupSession = {
    provider: choice.provider,
    profile: choice.profile,
    model: choice.model,
    effort: choice.effort,
    mode: existingConfig ? "update" : "setup",
    status: "running",
    startedAt,
    changedFiles: [],
    transcript: [{
      at: startedAt,
      kind: "status",
      label: `Starting ${choice.provider === "codex" ? "Codex" : "Claude"} configuration ${existingConfig ? "audit" : "setup"}`,
    }],
  };
  const updateSession = (change: Partial<ConfigurationSetupSession>) => {
    session = { ...session, ...change };
    onSessionChanged(session);
  };
  updateSession({});
  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `VibeCheck: ${existingConfig ? "Auditing" : "Creating"} configuration with ${choice.label}`,
        cancellable: true,
      },
      async (progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        return service.run(choice, snapshot.state.repositoryRoot, prompt, abort.signal, (event) => {
          progress.report({ message: event.detail ? `${event.label} · ${event.detail}` : event.label });
        }, (entry) => {
          const previous = session.transcript.at(-1);
          if (previous?.kind === entry.kind && previous.label === entry.label && previous.content === entry.content) return;
          updateSession({ transcript: [...session.transcript, { ...entry, at: new Date().toISOString() }].slice(-100) });
        });
      },
    );
    updateSession({
      status: "completed",
      finishedAt: new Date().toISOString(),
      changedFiles: result.changedFiles,
    });
    await controller.refresh();
    const detail = result.changedFiles.length
      ? `Updated ${result.changedFiles.join(", ")}.`
      : "The existing configuration was already current.";
    void vscode.window.showInformationMessage(`VibeCheck configuration completed. ${detail}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateSession({
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: message,
      transcript: [...session.transcript, {
        at: new Date().toISOString(),
        kind: "error" as const,
        label: "Configuration setup stopped",
        content: message,
      }].slice(-100),
    });
    void vscode.window.showErrorMessage(`VibeCheck configuration failed: ${message}`);
  }
}

async function refreshAgentInstructions(
  controller: ObservationController,
  service: InstructionRefreshService,
  previewProvider: InstructionPreviewProvider,
  scope: InstructionRefreshScope,
  onSessionChanged: (session: InstructionRefreshSession, proposal?: InstructionRefreshProposal) => void,
): Promise<void> {
  const snapshot = controller.getSnapshot();
  if (snapshot.kind !== "ready") return;
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage("Trust this VS Code workspace before invoking an instruction provider.");
    return;
  }
  const instructionFiles = scope === "instructions";
  const choice = await chooseProviderModel(
    instructionFiles ? "Choose model to generate AGENTS.md and CLAUDE.md" : "Choose model to generate supporting Claude and Codex files",
    "instructions",
  );
  if (!choice) return;
  const startedAt = new Date().toISOString();
  let session: InstructionRefreshSession = {
    scope,
    provider: choice.provider,
    profile: choice.profile,
    model: choice.model,
    effort: choice.effort,
    status: "running",
    startedAt,
    transcript: [{
      at: startedAt,
      kind: "status",
      label: `Starting ${choice.provider === "codex" ? "Codex" : "Claude"} workspace scan`,
    }],
    files: [],
  };
  previewProvider.setProposal(undefined);
  const updateSession = (change: Partial<InstructionRefreshSession>, proposal?: InstructionRefreshProposal) => {
    session = { ...session, ...change };
    onSessionChanged(session, proposal);
  };
  updateSession({});
  try {
    const proposal = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `VibeCheck: Generating ${instructionFiles ? "instruction" : "supporting workspace"} files with ${choice.label}`,
        cancellable: true,
      },
      async (progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        return service.propose(
          choice,
          snapshot.state.repositoryRoot,
          buildInstructionRefreshPrompt(scope),
          abort.signal,
          (event) => progress.report({ message: event.detail ? `${event.label} · ${event.detail}` : event.label }),
          (entry) => {
            const previous = session.transcript.at(-1);
            if (previous?.kind === entry.kind && previous.label === entry.label && previous.content === entry.content) return;
            updateSession({ transcript: [...session.transcript, { ...entry, at: new Date().toISOString() }].slice(-100) });
          },
          scope,
        );
      },
    );
    previewProvider.setProposal(proposal);
    updateSession({
      status: "preview",
      finishedAt: new Date().toISOString(),
      summary: proposal.summary,
      files: proposal.files.map(({ path: filePath, status, rationale }) => ({ path: filePath, status, rationale })),
    }, proposal);
    const firstChanged = proposal.files.find((file) => file.status !== "unchanged");
    if (firstChanged) {
      await previewAgentInstruction(previewProvider, proposal);
      void vscode.window.showInformationMessage(`${instructionFiles ? "Instruction" : "Supporting-file"} proposal is ready. Review the file diffs before applying all changes.`);
    } else {
      void vscode.window.showInformationMessage(
        instructionFiles
          ? "The existing instruction files already match the repository evidence."
          : "The selected provider found no justified supporting workspace changes.",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateSession({
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: message,
      transcript: [...session.transcript, {
        at: new Date().toISOString(),
        kind: "error" as const,
        label: "Agent Workspace scan stopped",
        content: message,
      }].slice(-100),
    });
    void vscode.window.showErrorMessage(`Agent Workspace generation failed: ${message}`);
  }
}

async function previewAgentInstruction(
  provider: InstructionPreviewProvider,
  proposal: InstructionRefreshProposal | undefined,
  file?: InstructionFilePath,
): Promise<void> {
  if (!proposal) return;
  const entries = file
    ? proposal.files.filter((candidate) => candidate.path === file)
    : proposal.files.filter((candidate) => candidate.status !== "unchanged");
  for (const entry of entries) {
    await vscode.commands.executeCommand(
      "vscode.diff",
      provider.uri("original", entry.path),
      provider.uri("proposed", entry.path),
      `${entry.path} — Current ↔ Proposed`,
      { preview: false },
    );
  }
}

async function applyAgentInstructionRefresh(
  controller: ObservationController,
  service: InstructionRefreshService,
  previewProvider: InstructionPreviewProvider,
  session: InstructionRefreshSession | undefined,
  proposal: InstructionRefreshProposal | undefined,
  backupRoot: string,
  refreshAlignment: () => Promise<void>,
  onSessionChanged: (session: InstructionRefreshSession, proposal?: InstructionRefreshProposal) => void,
): Promise<void> {
  const snapshot = controller.getSnapshot();
  if (snapshot.kind !== "ready" || !session || session.status !== "preview" || !proposal) return;
  const changed = proposal.files.filter((file) => file.status !== "unchanged").map((file) => file.path);
  if (!changed.length) {
    onSessionChanged({ ...session, status: "applied", finishedAt: new Date().toISOString() }, proposal);
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Apply all ${changed.length} reviewed Agent Workspace file${changed.length === 1 ? "" : "s"}? Existing files will be backed up outside the repository.`,
    { modal: true },
    "Apply Updates",
  );
  if (choice !== "Apply Updates") return;
  try {
    const result = await service.apply(snapshot.state.repositoryRoot, proposal, backupRoot);
    await controller.refresh();
    await refreshAlignment();
    previewProvider.setProposal(proposal);
    onSessionChanged({ ...session, status: "applied", finishedAt: new Date().toISOString() }, proposal);
    void vscode.window.showInformationMessage(
      `Updated ${result.changedFiles.join(" and ")}.${result.backupDirectory ? ` Previous contents were backed up to ${result.backupDirectory}.` : ""}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onSessionChanged({ ...session, status: "failed", finishedAt: new Date().toISOString(), error: message }, proposal);
    void vscode.window.showErrorMessage(`Could not apply Agent Workspace updates: ${message}`);
  }
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
