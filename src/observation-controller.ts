import { createHash } from "node:crypto";
import * as path from "node:path";

import * as vscode from "vscode";

import { AnalysisEngine } from "./analyzers/analysis-engine";
import { AgentFileCollector } from "./collectors/agent-file-collector";
import { GitCollector } from "./collectors/git-collector";
import { PlanCollector } from "./collectors/plan-collector";
import { WorkspaceWatcher } from "./collectors/workspace-watcher";
import { ConfigLoader } from "./config/config-loader";
import { AgentEvent } from "./domain/agent-events";
import { CodeReviewProvider, CodeReviewSelection, CodeReviewTranscriptEntry, RevisionRange } from "./domain/code-review";
import {
  DEFAULT_CONFIGURATION,
  VibeCheckConfiguration,
} from "./domain/configuration";
import { FindingStatus } from "./domain/findings";
import {
  OBSERVATION_STATE_VERSION,
  ObservationSnapshot,
  ObservationState,
} from "./domain/observation-state";
import { WorkspaceStore } from "./storage/workspace-store";
import { CodeReviewService } from "./reviews/code-review-service";
import { VerificationService } from "./verification/verification-service";

export class ObservationController implements vscode.Disposable {
  private snapshot: ObservationSnapshot = {
    kind: "unavailable",
    reason: "VibeCheck has not initialized this workspace.",
  };
  private configuration: VibeCheckConfiguration = DEFAULT_CONFIGURATION;
  private configurationError: string | undefined;
  private watcher: WorkspaceWatcher | undefined;
  private refreshInFlight: Promise<void> | undefined;
  private refreshRequested = false;
  private reviewActivityQueue: Promise<void> = Promise.resolve();
  private reviewTranscript: CodeReviewTranscriptEntry[] = [];

  public constructor(
    private readonly workspaceFolder: vscode.WorkspaceFolder,
    private readonly store: WorkspaceStore,
    private readonly git: GitCollector,
    private readonly plans: PlanCollector,
    private readonly agentFiles: AgentFileCollector,
    private readonly configLoader: ConfigLoader,
    private readonly analyzer: AnalysisEngine,
    private readonly verificationService: VerificationService,
    private readonly codeReviews: CodeReviewService,
    private readonly onStateChanged: () => void,
    private readonly output: vscode.OutputChannel,
  ) {}

  public getSnapshot(): ObservationSnapshot {
    return this.snapshot;
  }

  public getConfiguration(): VibeCheckConfiguration {
    return this.configuration;
  }

  public getConfigurationError(): string | undefined {
    return this.configurationError;
  }

  public getReviewTranscript(): CodeReviewTranscriptEntry[] {
    return this.reviewTranscript;
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

    if (vscode.workspace.getConfiguration("vibecheck").get("autoStart", true)) {
      await this.start();
      return;
    }
    this.snapshot = {
      kind: "unavailable",
      reason: "Observation is stopped. Run ‘VibeCheck: Start Observing’ to begin.",
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
        headBranch: repository.branch,
        headSubject: repository.subject,
        startedAt: now,
        lastUpdatedAt: now,
        paused: false,
        selectedPlanPath: previous?.selectedPlanPath,
        activePlan: previous?.activePlan,
        planCandidates: previous?.planCandidates ?? [],
        agentFiles: previous?.agentFiles ?? [],
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

  public async deleteData(): Promise<void> {
    await this.store.deleteObservation();
    this.snapshot = {
      kind: "unavailable",
      reason: "Local observation data was deleted. Start monitoring to rebuild workspace evidence.",
    };
    this.onStateChanged();
    this.output.appendLine("Local observation data deleted.");
  }

  public async selectPlan(relativePath: string): Promise<void> {
    await this.mutateState((state) => ({ ...state, selectedPlanPath: relativePath }));
    await this.refresh();
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
    const previous = this.snapshot.state.verification.find((item) => item.name === name);
    await this.replaceVerification({
      ...definition,
      status: "running",
      startedAt: new Date().toISOString(),
    });
    const result = await this.verificationService.run(repositoryRoot, definition, signal, undefined, previous);
    await this.replaceVerification(result);
    await this.refresh();
  }

  public async runCodeReview(selection: CodeReviewSelection, signal?: AbortSignal, range?: RevisionRange): Promise<void> {
    if (this.snapshot.kind !== "ready") return;
    const { provider } = selection;
    const state = this.snapshot.state;
    const changeFingerprint = this.changeFingerprint(state.changedFiles);
    const startedAt = new Date().toISOString();
    this.reviewActivityQueue = Promise.resolve();
    this.reviewTranscript = [];
    await this.mutateState((current) => ({
      ...current,
      codeReview: {
        provider,
        profile: selection.profile,
        model: selection.model,
        effort: selection.effort,
        status: "running",
        ...(range ? { range } : {}),
        baselineCommit: state.baselineCommit,
        changeFingerprint,
        startedAt,
        findings: [],
        activity: [{ at: startedAt, label: `Starting ${provider === "codex" ? "Codex" : "Claude"} review` }],
      },
    }));
    try {
      const result = await this.codeReviews.run(selection, state.repositoryRoot, signal, (progress) => {
        this.reviewActivityQueue = this.reviewActivityQueue.then(() =>
          this.appendReviewActivity(provider, startedAt, progress.label, progress.detail));
      }, (entry) => this.appendReviewTranscript(entry), range);
      await this.reviewActivityQueue;
      await this.mutateState((current) => ({
        ...current,
        codeReview: {
          provider,
          profile: selection.profile,
          model: selection.model,
          effort: selection.effort,
          status: range?.scope === "commits" || this.changeFingerprint(current.changedFiles) === changeFingerprint ? "completed" : "stale",
          ...(range ? { range } : {}),
          baselineCommit: state.baselineCommit,
          changeFingerprint,
          startedAt,
          finishedAt: new Date().toISOString(),
          summary: result.summary,
          findings: result.findings,
          activity: current.codeReview?.activity ?? [],
        },
      }));
    } catch (error) {
      const message = this.errorMessage(error);
      this.appendReviewTranscript({ kind: "error", label: "Review stopped", content: message });
      await this.mutateState((current) => ({
        ...current,
        codeReview: {
          provider,
          profile: selection.profile,
          model: selection.model,
          effort: selection.effort,
          status: "failed",
          baselineCommit: state.baselineCommit,
          changeFingerprint,
          startedAt,
          finishedAt: new Date().toISOString(),
          findings: [],
          activity: current.codeReview?.activity ?? [],
          error: message,
        },
      }));
      throw error;
    }
  }

  public async clearCodeReview(): Promise<boolean> {
    if (this.snapshot.kind !== "ready" || !this.snapshot.state.codeReview) return false;
    if (this.snapshot.state.codeReview.status === "running") return false;

    this.reviewTranscript = [];
    await this.mutateState((state) => {
      const { codeReview: _codeReview, ...withoutCodeReview } = state;
      return withoutCodeReview;
    });
    this.output.appendLine("Current code review cleared.");
    return true;
  }

  private appendReviewTranscript(entry: Omit<CodeReviewTranscriptEntry, "at">): void {
    const previous = this.reviewTranscript.at(-1);
    if (previous?.kind === entry.kind && previous.label === entry.label && previous.content === entry.content) {
      return;
    }
    const next = [...this.reviewTranscript, { ...entry, at: new Date().toISOString() }].slice(-100);
    let bytes = 0;
    const bounded: CodeReviewTranscriptEntry[] = [];
    for (let index = next.length - 1; index >= 0; index -= 1) {
      const size = Buffer.byteLength(JSON.stringify(next[index]), "utf8");
      if (bounded.length && bytes + size > 64 * 1024) break;
      bytes += size;
      bounded.unshift(next[index]);
    }
    this.reviewTranscript = bounded;
    this.onStateChanged();
  }

  private async appendReviewActivity(
    provider: CodeReviewProvider,
    startedAt: string,
    label: string,
    detail?: string,
  ): Promise<void> {
    await this.mutateState((state) => {
      const review = state.codeReview;
      if (!review || review.provider !== provider || review.startedAt !== startedAt || review.status !== "running") {
        return state;
      }
      const previous = review.activity.at(-1);
      if (previous?.label === label && previous.detail === detail) return state;
      return {
        ...state,
        codeReview: {
          ...review,
          activity: [...review.activity, { at: new Date().toISOString(), label, detail }].slice(-20),
        },
      };
    });
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

      const repository = await this.git.discover(this.snapshot.state.repositoryRoot);
      const commitAdvanced = repository.head !== this.snapshot.state.baselineCommit;
      const baselineCommit = repository.head;
      const changedFiles = await this.git.collectChanges(
        this.snapshot.state.repositoryRoot,
        baselineCommit,
      );
      const planCandidates = await this.plans.collect(
        this.snapshot.state.repositoryRoot,
        this.configuration.plans,
        this.snapshot.state.selectedPlanPath,
      );
      const activePlan = this.plans.choose(
        planCandidates,
        this.configuration.plans,
        this.snapshot.state.selectedPlanPath,
      );
      const agentFiles = await this.agentFiles.collect(this.snapshot.state.repositoryRoot);
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
        commitAdvanced ? [] : this.snapshot.state.findings,
      );
      const codeReview = this.snapshot.state.codeReview
        && this.snapshot.state.codeReview.status === "completed"
        && this.snapshot.state.codeReview.range?.scope !== "commits"
        && this.snapshot.state.codeReview.changeFingerprint !== this.changeFingerprint(changedFiles)
        ? { ...this.snapshot.state.codeReview, status: "stale" as const }
        : this.snapshot.state.codeReview;
      await this.updateState({
        ...this.snapshot.state,
        baselineCommit,
        headBranch: repository.branch,
        headSubject: repository.subject,
        startedAt: commitAdvanced ? new Date().toISOString() : this.snapshot.state.startedAt,
        changedFiles,
        planCandidates,
        activePlan,
        agentFiles,
        findings,
        codeReview,
        verification,
        lastUpdatedAt: new Date().toISOString(),
      });
      if (commitAdvanced) this.output.appendLine(`Commit changed; now observing from ${baselineCommit.slice(0, 12)}.`);
    } catch (error) {
      this.output.appendLine(`Refresh failed: ${this.errorMessage(error)}`);
      void vscode.window.showWarningMessage(`VibeCheck refresh failed: ${this.errorMessage(error)}`);
    }
  }

  private changeFingerprint(changedFiles: ObservationState["changedFiles"]): string {
    const hash = createHash("sha256");
    for (const change of changedFiles) {
      hash.update(change.path).update("\0").update(change.status).update("\0");
      hash.update(change.before ?? "").update("\0").update(change.after ?? "").update("\0");
    }
    return hash.digest("hex");
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
      () => vscode.workspace.getConfiguration("vibecheck").get("refreshDebounceMs", 750),
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
