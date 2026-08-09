import * as vscode from "vscode";

import { ObservationSnapshot } from "../domain/observation-state";

export class IntentLoopStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  public constructor() {
    this.item.name = "VibeCheck";
    this.item.command = "intentLoop.overview.focus";
    this.item.show();
  }

  public render(snapshot: ObservationSnapshot): void {
    if (snapshot.kind === "unavailable") {
      this.item.text = "$(circle-slash) VibeCheck";
      this.item.tooltip = snapshot.reason;
      return;
    }
    const state = snapshot.state;
    if (state.paused) {
      this.item.text = "$(debug-pause) VibeCheck: paused";
      this.item.tooltip = "Observation is paused. Click to open VibeCheck.";
      return;
    }
    const open = state.findings.filter((finding) => finding.status === "open");
    const stale = state.verification.filter((item) => item.status === "stale").length;
    const failed = state.verification.filter((item) => item.status === "failed").length;
    if (open.length > 0 || stale > 0 || failed > 0) {
      this.item.text = `$(warning) VibeCheck: ${open.length} attention${stale ? ` · ${stale} stale` : ""}${failed ? ` · ${failed} failed` : ""}`;
      this.item.tooltip = "VibeCheck has findings or verification needing attention.";
      return;
    }
    const passed = state.verification.filter((item) => item.status === "passed").length;
    this.item.text = state.verification.length
      ? `$(shield) VibeCheck: ${passed}/${state.verification.length} checks current`
      : "$(shield) VibeCheck: configure checks";
    this.item.tooltip = `Monitoring quality against current commit ${state.baselineCommit.slice(0, 12)}.`;
  }

  public dispose(): void {
    this.item.dispose();
  }
}
