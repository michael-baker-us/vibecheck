import * as vscode from "vscode";

import { VibeCheckConfiguration } from "../domain/configuration";
import { ChangeSummarySession } from "../domain/change-summary";
import { ConfigurationSetupSession } from "../domain/configuration-setup";
import { InstructionRefreshSession } from "../domain/instruction-refresh";
import { ReadmeMaintenanceSession } from "../domain/readme-maintenance";
import { AgentAlignmentSnapshot } from "../agent-instructions/alignment-service";
import { categoryFor, calculateReadiness, missingRecommendedCategories } from "../domain/quality-gates";
import { ObservationSnapshot } from "../domain/observation-state";
import { ProviderUsageSnapshot } from "../usage/provider-usage-service";
import { DEFAULT_MODEL_ROUTING, MODEL_ROUTING_SETTINGS, normalizeModelRouting } from "../providers/model-routing";
import { controlCenterHtml } from "./control-center-view";

type WebviewMessage = { action?: unknown; id?: unknown; options?: unknown };

export class ControlCenterProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  public constructor(
    private readonly getSnapshot: () => ObservationSnapshot,
    private readonly getConfiguration: () => VibeCheckConfiguration,
    private readonly getConfigurationError: () => string | undefined,
    private readonly getReviewTranscript: () => Array<{ at: string; kind: string; label: string; content?: string }>,
    private readonly getChangeSummarySession: () => ChangeSummarySession | undefined,
    private readonly getReadmeMaintenanceSession: () => ReadmeMaintenanceSession | undefined,
    private readonly getConfigurationSetupSession: () => ConfigurationSetupSession | undefined,
    private readonly getInstructionRefreshSession: () => InstructionRefreshSession | undefined,
    private readonly getProviderUsage: () => ProviderUsageSnapshot,
    private readonly getAgentAlignment: () => AgentAlignmentSnapshot,
    private readonly version: string = "unknown",
  ) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: WebviewMessage) => void this.handle(message));
    this.refresh();
  }

  public refresh(): void {
    if (!this.view) return;
    const snapshot = this.getSnapshot();
    const configuration = this.getConfiguration();
    const missingGates = missingRecommendedCategories(configuration.verification);
    const baseReadiness = snapshot.kind === "ready"
      ? calculateReadiness(snapshot.state.findings, snapshot.state.verification)
      : undefined;
    const readiness = baseReadiness && missingGates.length
      ? {
          status: baseReadiness.status === "ready" ? "incomplete" as const : baseReadiness.status,
          label: baseReadiness.status === "ready" ? "Setup incomplete" : baseReadiness.label,
          reasons: [...baseReadiness.reasons, `Missing recommended gates: ${missingGates.join(", ")}`],
        }
      : baseReadiness;
    const payload = snapshot.kind === "ready"
      ? {
          kind: "ready",
          state: snapshot.state,
          readiness,
          missingGates,
          categories: Object.fromEntries(
            configuration.verification.map((definition) => [definition.name, categoryFor(definition)]),
          ),
          configurationError: this.getConfigurationError(),
          reviewTranscript: this.getReviewTranscript(),
          changeSummarySession: this.getChangeSummarySession(),
          readmeMaintenanceSession: this.getReadmeMaintenanceSession(),
          configurationSetupSession: this.getConfigurationSetupSession(),
          instructionRefreshSession: this.getInstructionRefreshSession(),
          providerUsage: this.getProviderUsage(),
          agentAlignment: this.getAgentAlignment(),
          recommendations: configuration.recommendations,
          modelRouting: readModelRouting(),
          version: this.version,
          alignAgentWorkspace: vscode.workspace.getConfiguration(
            "vibecheck",
            vscode.workspace.workspaceFolders?.[0]?.uri,
          ).get<boolean>("alignAgentWorkspace", false),
        }
      : { ...snapshot, version: this.version };
    void this.view.webview.postMessage({ type: "state", payload });
  }

  private async handle(message: WebviewMessage): Promise<void> {
    if (typeof message.action !== "string") return;
    if (message.action === "summarize-changes" && message.options !== undefined) {
      await vscode.commands.executeCommand("vibecheck.summarizeChanges", message.options);
      return;
    }
    if (message.action === "set-agent-alignment" && typeof message.options === "boolean") {
      await vscode.commands.executeCommand("vibecheck.setAgentAlignment", message.options);
      return;
    }
    if (message.action === "resolve-agent-alignment" && typeof message.id === "string") {
      await vscode.commands.executeCommand("vibecheck.resolveAgentAlignment", message.id);
      return;
    }
    if (message.action === "set-model-routing") {
      await vscode.commands.executeCommand("vibecheck.setModelRouting", message.options);
      return;
    }
    const id = typeof message.id === "string" ? message.id : undefined;
    const simpleCommands: Record<string, string> = {
      "select-plan": "vibecheck.selectPlan",
      "open-plan": "vibecheck.openPlan",
      refresh: "vibecheck.refresh",
      "refresh-provider-usage": "vibecheck.refreshProviderUsage",
      pause: "vibecheck.pause",
      resume: "vibecheck.start",
      "run-all": "vibecheck.runAllVerification",
      "run-review": "vibecheck.runCodeReview",
      "clear-review": "vibecheck.clearCodeReview",
      "preview-review": "vibecheck.previewCodeReview",
      "summarize-changes": "vibecheck.summarizeChanges",
      "maintain-readme": "vibecheck.maintainReadme",
      "check-output-menu": "vibecheck.showVerificationOutput",
      "copy-prompt": "vibecheck.copyPrompt",
      export: "vibecheck.createReport",
      config: "vibecheck.openConfig",
      "setup-prompt": "vibecheck.createSetupPrompt",
      "install-codex": "vibecheck.installCodexAdapter",
      "install-claude": "vibecheck.installClaudeAdapter",
      "remove-adapter": "vibecheck.uninstallAgentAdapter",
      "generate-agent-instructions": "vibecheck.generateAgentInstructions",
      "refresh-agent-instructions": "vibecheck.refreshAgentInstructions",
      "preview-agent-workspace": "vibecheck.previewAgentInstruction",
      "apply-agent-instructions": "vibecheck.applyAgentInstructionRefresh",
      "discard-agent-instructions": "vibecheck.discardAgentInstructionRefresh",
      "align-agent-instructions": "vibecheck.alignAgentInstructions",
      "clear-agent-workspace": "vibecheck.clearAgentWorkspace",
      delete: "vibecheck.deleteData",
      start: "vibecheck.start",
    };
    const command = simpleCommands[message.action];
    if (command) {
      await vscode.commands.executeCommand(command);
      return;
    }

    const snapshot = this.getSnapshot();
    if (snapshot.kind !== "ready" || !id) return;
    if (message.action === "open-agent-capability-template") {
      await vscode.commands.executeCommand("vibecheck.openAgentCapabilityTemplate", id);
      return;
    }
    if (message.action === "manage-agent-file") {
      await vscode.commands.executeCommand("vibecheck.manageAgentFile", id);
      return;
    }
    if (message.action === "preview-agent-instruction") {
      await vscode.commands.executeCommand("vibecheck.previewAgentInstruction", id);
      return;
    }
    if (message.action === "apply-recommendation" && id) {
      await vscode.commands.executeCommand("vibecheck.applyGateRecommendation", id);
      return;
    }
    if (message.action === "inspect-review") {
      await vscode.commands.executeCommand("vibecheck.inspectCodeReviewFinding", id);
      return;
    }
    const finding = snapshot.state.findings.find((item) => item.id === id);
    if (finding) {
      const findingCommands: Record<string, string> = {
        "inspect-finding": "vibecheck.inspectFinding",
        "accept-finding": "vibecheck.acceptFinding",
        "dismiss-finding": "vibecheck.dismissFinding",
        "reopen-finding": "vibecheck.reopenFinding",
        "prompt-finding": "vibecheck.copyPrompt",
      };
      const findingCommand = findingCommands[message.action];
      if (findingCommand) await vscode.commands.executeCommand(findingCommand, finding);
      return;
    }
    if (message.action === "run-check") await vscode.commands.executeCommand("vibecheck.runVerification", id);
    if (message.action === "check-output") await vscode.commands.executeCommand("vibecheck.showVerificationOutput", id);
  }

  private html(webview: vscode.Webview): string {
    return controlCenterHtml(webview.cspSource);
  }
}

function readModelRouting() {
  const configuration = vscode.workspace.getConfiguration("vibecheck", vscode.workspace.workspaceFolders?.[0]?.uri);
  return normalizeModelRouting({
    codexBalanced: configuration.get<string>(MODEL_ROUTING_SETTINGS.codexBalanced, DEFAULT_MODEL_ROUTING.codexBalanced),
    codexDeep: configuration.get<string>(MODEL_ROUTING_SETTINGS.codexDeep, DEFAULT_MODEL_ROUTING.codexDeep),
    claudeBalanced: configuration.get<string>(MODEL_ROUTING_SETTINGS.claudeBalanced, DEFAULT_MODEL_ROUTING.claudeBalanced),
    claudeDeep: configuration.get<string>(MODEL_ROUTING_SETTINGS.claudeDeep, DEFAULT_MODEL_ROUTING.claudeDeep),
  });
}
