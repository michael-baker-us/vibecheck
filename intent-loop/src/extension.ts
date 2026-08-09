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
import { CodeReviewFinding, CodeReviewSelection } from "./domain/code-review";
import { ChangeSummaryRange, ChangeSummarySession } from "./domain/change-summary";
import { Finding } from "./domain/findings";
import { ObservationController } from "./observation-controller";
import { buildFollowUpPrompt } from "./prompts/follow-up-builder";
import { buildMarkdownReport } from "./reports/markdown-report";
import { buildCodeReviewMarkdown } from "./reports/code-review-markdown";
import { buildChangeSummaryMarkdown } from "./reports/change-summary-markdown";
import { CodeReviewService } from "./reviews/code-review-service";
import { WorkspaceStore } from "./storage/workspace-store";
import { ChangeSummaryService } from "./summaries/change-summary-service";
import { FindingDiagnostics } from "./ui/diagnostics";
import { ControlCenterProvider } from "./ui/control-center";
import { IntentLoopStatusBar } from "./ui/status-bar";
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
  let changeSummarySession: ChangeSummarySession | undefined;
  let providerUsage = usageService.emptySnapshot();
  const adapters = new AdapterInstaller(context.asAbsolutePath("resources/hook-bridge.cjs"));
  const statusBar = new IntentLoopStatusBar();
  const diagnostics = new FindingDiagnostics();
  let controller: ObservationController;
  const controlCenter = new ControlCenterProvider(
    () => controller.getSnapshot(),
    () => controller.getConfiguration(),
    () => controller.getConfigurationError(),
    () => controller.getReviewTranscript(),
    () => changeSummarySession,
    () => providerUsage,
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
    vscode.commands.registerCommand("intentLoop.refreshProviderUsage", async () => {
      providerUsage = usageService.loadingSnapshot(providerUsage);
      controlCenter.refresh();
      providerUsage = await usageService.collect();
      controlCenter.refresh();
    }),
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
    vscode.commands.registerCommand("intentLoop.runCodeReview", () => runCodeReview(controller)),
    vscode.commands.registerCommand("intentLoop.clearCodeReview", () => clearCodeReview(controller)),
    vscode.commands.registerCommand("intentLoop.inspectCodeReviewFinding", (findingId?: string) =>
      inspectCodeReviewFinding(controller, findingId),
    ),
    vscode.commands.registerCommand("intentLoop.previewCodeReview", () => previewCodeReview(controller)),
    vscode.commands.registerCommand("intentLoop.summarizeChanges", (options?: unknown) =>
      summarizeChanges(controller, git, changeSummaryService, (session) => {
        changeSummarySession = session;
        controlCenter.refresh();
      }, options)),
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
  void vscode.commands.executeCommand("intentLoop.refreshProviderUsage");
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

type ProviderModelChoice = CodeReviewSelection & vscode.QuickPickItem & { label: string; key: ChangeSummaryOptions["model"] };

async function chooseProviderModel(
  title: string,
  purpose: "review" | "summary",
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

function providerModelChoices(purpose: "review" | "summary"): ProviderModelChoice[] {
  const balancedDetail = purpose === "summary"
    ? "Recommended for concise summaries with lower latency and cost."
    : "Faster routine review with balanced capability and latency.";
  const deepDetail = purpose === "summary"
    ? "Higher-cost option for unusually large or complex comparisons."
    : "Quality-first review for large, sensitive, or difficult changes.";
  return [
    { key: "codex-balanced", label: "Codex · Balanced (Default)", description: "gpt-5.6-terra · medium effort", detail: balancedDetail, provider: "codex", profile: "balanced", model: "gpt-5.6-terra", effort: "medium" },
    { key: "codex-deep", label: "Codex · Deep", description: "gpt-5.6-sol · high effort", detail: deepDetail, provider: "codex", profile: "deep", model: "gpt-5.6-sol", effort: "high" },
    { key: "claude-balanced", label: "Claude · Balanced (Default)", description: "claude-sonnet-5 · medium effort", detail: balancedDetail, provider: "claude", profile: "balanced", model: "claude-sonnet-5", effort: "medium" },
    { key: "claude-deep", label: "Claude · Deep", description: "claude-opus-5 · high effort", detail: deepDetail, provider: "claude", profile: "deep", model: "claude-opus-5", effort: "high" },
  ];
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
