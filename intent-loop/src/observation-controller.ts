import * as vscode from "vscode";

import { GitCollector } from "./collectors/git-collector";
import { WorkspaceWatcher } from "./collectors/workspace-watcher";
import {
  OBSERVATION_STATE_VERSION,
  ObservationSnapshot,
  ObservationState,
} from "./domain/observation-state";
import { WorkspaceStore } from "./storage/workspace-store";

export class ObservationController implements vscode.Disposable {
  private snapshot: ObservationSnapshot = {
    kind: "unavailable",
    reason: "Intent Loop has not initialized this workspace.",
  };
  private watcher: WorkspaceWatcher | undefined;
  private refreshInFlight: Promise<void> | undefined;
  private refreshRequested = false;

  public constructor(
    private readonly workspaceFolder: vscode.WorkspaceFolder,
    private readonly store: WorkspaceStore,
    private readonly git: GitCollector,
    private readonly onStateChanged: () => void,
    private readonly output: vscode.OutputChannel,
  ) {}

  public getSnapshot(): ObservationSnapshot {
    return this.snapshot;
  }

  public async initialize(): Promise<void> {
    this.startWatcher();

    const stored = this.store.getObservation();
    if (stored && stored.workspaceRoot === this.workspaceFolder.uri.fsPath) {
      this.snapshot = { kind: "ready", state: stored };
      this.onStateChanged();
      if (!stored.paused) {
        await this.refresh();
      }
      return;
    }

    const autoStart = vscode.workspace.getConfiguration("intentLoop").get("autoStart", true);
    if (autoStart) {
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
      const now = new Date().toISOString();
      const state: ObservationState = {
        version: OBSERVATION_STATE_VERSION,
        workspaceRoot: this.workspaceFolder.uri.fsPath,
        repositoryRoot: repository.root,
        baselineCommit: repository.head,
        startedAt: now,
        lastUpdatedAt: now,
        paused: false,
        changedPaths: [],
      };

      this.snapshot = { kind: "ready", state };
      await this.store.saveObservation(state);
      this.onStateChanged();
      await this.refresh();
      this.output.appendLine(`Observation started at ${repository.head.slice(0, 12)}.`);
    } catch (error) {
      this.setUnavailable(error);
    }
  }

  public async pause(): Promise<void> {
    if (this.snapshot.kind !== "ready") {
      return;
    }

    const state = { ...this.snapshot.state, paused: true };
    this.snapshot = { kind: "ready", state };
    await this.store.saveObservation(state);
    this.onStateChanged();
    this.output.appendLine("Observation paused.");
  }

  public async resume(): Promise<void> {
    if (this.snapshot.kind !== "ready") {
      await this.start();
      return;
    }

    const state = { ...this.snapshot.state, paused: false };
    this.snapshot = { kind: "ready", state };
    await this.store.saveObservation(state);
    this.onStateChanged();
    await this.refresh();
    this.output.appendLine("Observation resumed.");
  }

  public async reset(): Promise<void> {
    await this.start();
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
    if (this.snapshot.kind !== "ready" || this.snapshot.state.paused) {
      return;
    }

    try {
      const changedPaths = await this.git.listChangedPaths(
        this.snapshot.state.repositoryRoot,
        this.snapshot.state.baselineCommit,
      );
      const state: ObservationState = {
        ...this.snapshot.state,
        changedPaths,
        lastUpdatedAt: new Date().toISOString(),
      };
      this.snapshot = { kind: "ready", state };
      await this.store.saveObservation(state);
      this.onStateChanged();
    } catch (error) {
      this.output.appendLine(`Refresh failed: ${this.errorMessage(error)}`);
      void vscode.window.showWarningMessage(`Intent Loop refresh failed: ${this.errorMessage(error)}`);
    }
  }

  private startWatcher(): void {
    this.watcher?.dispose();
    this.watcher = new WorkspaceWatcher(
      this.workspaceFolder,
      () => vscode.workspace.getConfiguration("intentLoop").get("refreshDebounceMs", 750),
      () => void this.refresh(),
    );
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
