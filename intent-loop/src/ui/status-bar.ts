import * as vscode from "vscode";

import { ObservationSnapshot } from "../domain/observation-state";

export class IntentLoopStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  public constructor() {
    this.item.name = "Intent Loop";
    this.item.command = "intentLoop.overview.focus";
    this.item.show();
  }

  public render(snapshot: ObservationSnapshot): void {
    if (snapshot.kind === "unavailable") {
      this.item.text = "$(circle-slash) Intent Loop";
      this.item.tooltip = snapshot.reason;
      return;
    }
    const state = snapshot.state;
    if (state.paused) {
      this.item.text = `$(debug-pause) Intent Loop: ${state.changedFiles.length} changes`;
      this.item.tooltip = "Observation is paused. Click to open Intent Loop.";
      return;
    }
    const open = state.findings.filter((finding) => finding.status === "open");
    const stale = state.verification.filter((item) => item.status === "stale").length;
    const failed = state.verification.filter((item) => item.status === "failed").length;
    if (open.length > 0 || stale > 0 || failed > 0) {
      this.item.text = `$(warning) Intent Loop: ${open.length} attention${stale ? ` · ${stale} stale` : ""}${failed ? ` · ${failed} failed` : ""}`;
      this.item.tooltip = "Intent Loop has findings or verification needing attention.";
      return;
    }
    this.item.text = `$(pulse) Intent Loop: ${state.changedFiles.length} ${state.changedFiles.length === 1 ? "change" : "changes"}`;
    this.item.tooltip = `Observing from ${state.baselineCommit.slice(0, 12)}. No current findings.`;
  }

  public dispose(): void {
    this.item.dispose();
  }
}
