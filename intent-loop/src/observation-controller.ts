import * as path from "node:path";

import * as vscode from "vscode";

import { AnalysisEngine } from "./analyzers/analysis-engine";
import { GitCollector } from "./collectors/git-collector";
import { WorkspaceWatcher } from "./collectors/workspace-watcher";
import { ConfigLoader } from "./config/config-loader";
import { AgentEvent } from "./domain/agent-events";
import {
  DEFAULT_CONFIGURATION,
  IntentLoopConfiguration,
} from "./domain/configuration";
import { FindingStatus } from "./domain/findings";
import {
  OBSERVATION_STATE_VERSION,
  ObservationSnapshot,
  ObservationState,
} from "./domain/observation-state";
import { WorkspaceStore } from "./storage/workspace-store";
import { VerificationService } from "./verification/verification-service";

export class ObservationController implements vscode.Disposable {
  private snapshot: ObservationSnapshot = {
    kind: "unavailable",
    reason: "Intent Loop has not initialized this workspace.",
  };
  private configuration: IntentLoopConfiguration = DEFAULT_CONFIGURATION;
  private configurationError: string | undefined;
  private watcher: WorkspaceWatcher | undefined;
  private refreshInFlight: Promise<void> | undefined;
  private refreshRequested = false;

  public constructor(
    private readonly workspaceFolder: vscode.WorkspaceFolder,
    private readonly store: WorkspaceStore,
    private readonly git: GitCollector,
    private readonly configLoader: ConfigLoader,
    private readonly analyzer: AnalysisEngine,
    private readonly verificationService: VerificationService,
    private readonly onStateChanged: () => void,
    private readonly output: vscode.OutputChannel,
  ) {}

  public getSnapshot(): ObservationSnapshot {
    return this.snapshot;
  }

  public getConfiguration(): IntentLoopConfiguration {
    return this.configuration;
  }

  public getConfigurationError(): string | undefined {
    return this.configurationError;
  }

  public async getDiff(relativePath?: string): Promise<string> {
    if (this.snapshot.kind !== "ready") return "";
    return this.git.getDiff(
      this.snapshot.state.repositoryRoot,
      this.snapshot.state.baselineCommit,
      relativePath,
    );
  }

  public async initialize(): Promise<void> {
    const stored = this.store.getObservation();
    if (stored && stored.workspaceRoot === this.workspaceFolder.uri.fsPath) {
      this.startWatcher(stored.repositoryRoot);
      this.snapshot = { kind: "ready", state: stored };
      this.onStateChanged();
      if (!stored.paused) await this.refresh();
      return;
    }

    if (vscode.workspace.getConfiguration("intentLoop").get("autoStart", true)) {
      await this.start();
      return;
    }
    this.snapshot = {
      kind: "unavailable",
      reason: "Observation is stopped. Run ‘Intent Loop: Start Observing’ to begin.",
    };
    this.onStateChanged();
  }

  public async start(): Promise<void> {
    try {
      const repository = await this.git.discover(this.workspaceFolder.uri.fsPath);
      this.startWatcher(repository.root);
      const now = new Date().toISOString();
      const previous = this.snapshot.kind === "ready" ? this.snapshot.state : undefined;
      const state: ObservationState = {
        version: OBSERVATION_STATE_VERSION,
        workspaceRoot: this.workspaceFolder.uri.fsPath,
        repositoryRoot: repository.root,
        baselineCommit: repository.head,
        startedAt: now,
        lastUpdatedAt: now,
        paused: false,
        workingIntent: previous?.workingIntent,
        changedFiles: [],
        findings: [],
        verification: [],
        trustedCommandHashes: previous?.trustedCommandHashes ?? [],
        agent: previous?.agent ?? { connectedAgents: [] },
      };
      await this.updateState(state);
      await this.refresh();
      this.output.appendLine(`Observation started at ${repository.head.slice(0, 12)}.`);
    } catch (error) {
      this.setUnavailable(error);
    }
  }

  public async pause(): Promise<void> {
    await this.mutateState((state) => ({ ...state, paused: true }));
    this.output.appendLine("Observation paused.");
  }

  public async resume(): Promise<void> {
    if (this.snapshot.kind !== "ready") {
      await this.start();
      return;
    }
    await this.mutateState((state) => ({ ...state, paused: false }));
    await this.refresh();
    this.output.appendLine("Observation resumed.");
  }

  public async reset(): Promise<void> {
    await this.start();
  }

  public async isWorkingTreeClean(): Promise<boolean> {
    if (this.snapshot.kind !== "ready") return false;
    return this.git.isWorkingTreeClean(this.snapshot.state.repositoryRoot);
  }

  public async deleteData(): Promise<void> {
    await this.store.deleteObservation();
    this.snapshot = {
      kind: "unavailable",
      reason: "Local observation data was deleted. Start observing to create a new baseline.",
    };
    this.onStateChanged();
    this.output.appendLine("Local observation data deleted.");
  }

  public async setWorkingIntent(intent: string | undefined): Promise<void> {
    await this.mutateState((state) => ({ ...state, workingIntent: intent?.trim() || undefined }));
  }

  public async ingestAgentEvent(event: AgentEvent): Promise<void> {
    if (this.snapshot.kind !== "ready" || !event.workspace) return;
    const relative = path.relative(this.snapshot.state.repositoryRoot, event.workspace);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return;
    await this.mutateState((state) => {
      const agents = new Set(state.agent.connectedAgents);
      if (event.type === "session-end") agents.delete(event.agent);
      else agents.add(event.agent);
      return {
        ...state,
        agent: {
          connectedAgents: [...agents],
          lastEventAt: event.at,
          lastEventType: event.type,
        },
      };
    });
    if (event.type === "tool-finished" || event.type === "turn-stop") {
      await this.refresh();
    }
  }

  public async setFindingStatus(findingId: string, status: FindingStatus): Promise<void> {
    await this.mutateState((state) => ({
      ...state,
      findings: state.findings.map((finding) =>
        finding.id === findingId ? { ...finding, status } : finding,
      ),
    }));
  }

  public isVerificationTrusted(name: string): boolean {
    if (this.snapshot.kind !== "ready") return false;
    const definition = this.configuration.verification.find((item) => item.name === name);
    if (!definition) return false;
    const hash = this.verificationService.commandHash(this.snapshot.state.repositoryRoot, definition.command);
    return this.snapshot.state.trustedCommandHashes.includes(hash);
  }

  public async trustVerification(name: string): Promise<void> {
    if (this.snapshot.kind !== "ready") return;
    const definition = this.configuration.verification.find((item) => item.name === name);
    if (!definition) return;
    const hash = this.verificationService.commandHash(this.snapshot.state.repositoryRoot, definition.command);
    await this.mutateState((state) => ({
      ...state,
      trustedCommandHashes: [...new Set([...state.trustedCommandHashes, hash])],
    }));
  }

  public async runVerification(name: string, signal?: AbortSignal): Promise<void> {
    if (this.snapshot.kind !== "ready") return;
    const definition = this.configuration.verification.find((item) => item.name === name);
    if (!definition) throw new Error(`Unknown verification command: ${name}`);
    const repositoryRoot = this.snapshot.state.repositoryRoot;
    await this.replaceVerification({
      ...definition,
      status: "running",
      startedAt: new Date().toISOString(),
    });
    const result = await this.verificationService.run(repositoryRoot, definition, signal);
    await this.replaceVerification(result);
    await this.refresh();
  }

  public async refresh(): Promise<void> {
    if (this.refreshInFlight) {
      this.refreshRequested = true;
      return this.refreshInFlight;
    }
    this.refreshInFlight = this.performRefresh();
    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = undefined;
      if (this.refreshRequested) {
        this.refreshRequested = false;
        await this.refresh();
      }
    }
  }

  public dispose(): void {
    this.watcher?.dispose();
  }

  private async performRefresh(): Promise<void> {
    if (this.snapshot.kind !== "ready" || this.snapshot.state.paused) return;
    try {
      try {
        this.configuration = await this.configLoader.load(this.snapshot.state.repositoryRoot);
        this.configurationError = undefined;
      } catch (error) {
        this.configuration = DEFAULT_CONFIGURATION;
        this.configurationError = this.errorMessage(error);
        this.output.appendLine(`Configuration error: ${this.configurationError}`);
      }

      const changedFiles = await this.git.collectChanges(
        this.snapshot.state.repositoryRoot,
        this.snapshot.state.baselineCommit,
      );
      const aligned = this.verificationService.alignDefinitions(
        this.configuration.verification,
        this.snapshot.state.verification,
      );
      const verification = await this.verificationService.refreshFreshness(
        this.snapshot.state.repositoryRoot,
        aligned,
      );
      const findings = this.analyzer.analyze(
        changedFiles,
        this.configuration,
        this.snapshot.state.findings,
      );
      await this.updateState({
        ...this.snapshot.state,
        changedFiles,
        findings,
        verification,
        lastUpdatedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.output.appendLine(`Refresh failed: ${this.errorMessage(error)}`);
      void vscode.window.showWarningMessage(`Intent Loop refresh failed: ${this.errorMessage(error)}`);
    }
  }

  private async replaceVerification(replacement: ObservationState["verification"][number]): Promise<void> {
    await this.mutateState((state) => ({
      ...state,
      verification: [
        ...state.verification.filter((item) => item.name !== replacement.name),
        replacement,
      ],
    }));
  }

  private startWatcher(repositoryRoot: string): void {
    this.watcher?.dispose();
    this.watcher = new WorkspaceWatcher(
      vscode.Uri.file(repositoryRoot),
      () => vscode.workspace.getConfiguration("intentLoop").get("refreshDebounceMs", 750),
      () => void this.refresh(),
    );
  }

  private async mutateState(update: (state: ObservationState) => ObservationState): Promise<void> {
    if (this.snapshot.kind !== "ready") return;
    await this.updateState(update(this.snapshot.state));
  }

  private async updateState(state: ObservationState): Promise<void> {
    this.snapshot = { kind: "ready", state };
    await this.store.saveObservation(state);
    this.onStateChanged();
  }

  private setUnavailable(error: unknown): void {
    const reason = this.errorMessage(error);
    this.snapshot = { kind: "unavailable", reason };
    this.onStateChanged();
    this.output.appendLine(`Initialization failed: ${reason}`);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
