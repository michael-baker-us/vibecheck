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

    if (snapshot.state.paused) {
      this.item.text = `$(debug-pause) Intent Loop: ${snapshot.state.changedPaths.length} changes`;
      this.item.tooltip = "Observation is paused. Click to open Intent Loop.";
      return;
    }

    const count = snapshot.state.changedPaths.length;
    this.item.text = `$(pulse) Intent Loop: ${count} ${count === 1 ? "change" : "changes"}`;
    this.item.tooltip = `Observing from ${snapshot.state.baselineCommit.slice(0, 12)}. Click to open Intent Loop.`;
  }

  public dispose(): void {
    this.item.dispose();
  }
}
