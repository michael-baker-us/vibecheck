import * as path from "node:path";

import * as vscode from "vscode";

const IGNORED_SEGMENTS = new Set([".git", ".vscode-test", "coverage", "dist", "node_modules", "out"]);

export class WorkspaceWatcher implements vscode.Disposable {
  private readonly watcher: vscode.FileSystemWatcher;
  private timer: NodeJS.Timeout | undefined;

  public constructor(
    root: vscode.WorkspaceFolder | vscode.Uri,
    private readonly debounceMs: () => number,
    private readonly onChanged: () => void,
  ) {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, "**/*"),
    );

    this.watcher.onDidCreate((uri) => this.schedule(uri));
    this.watcher.onDidChange((uri) => this.schedule(uri));
    this.watcher.onDidDelete((uri) => this.schedule(uri));
  }

  public dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.watcher.dispose();
  }

  private schedule(uri: vscode.Uri): void {
    const segments = uri.fsPath.split(path.sep);
    if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) {
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onChanged();
    }, this.debounceMs());
  }
}
