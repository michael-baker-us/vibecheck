import * as path from "node:path";

import * as vscode from "vscode";

import { ObservationSnapshot } from "../domain/observation-state";

type OverviewNode =
  | { kind: "message"; label: string; description?: string; icon: string }
  | { kind: "changed-files"; count: number }
  | { kind: "file"; relativePath: string; repositoryRoot: string };

export class OverviewTreeProvider implements vscode.TreeDataProvider<OverviewNode> {
  private readonly changedEmitter = new vscode.EventEmitter<OverviewNode | undefined>();
  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor(private readonly getSnapshot: () => ObservationSnapshot) {}

  public refresh(): void {
    this.changedEmitter.fire(undefined);
  }

  public getTreeItem(node: OverviewNode): vscode.TreeItem {
    if (node.kind === "changed-files") {
      const item = new vscode.TreeItem(
        `${node.count} changed ${node.count === 1 ? "file" : "files"}`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon("files");
      return item;
    }

    if (node.kind === "file") {
      const item = new vscode.TreeItem(node.relativePath, vscode.TreeItemCollapsibleState.None);
      const uri = vscode.Uri.file(path.join(node.repositoryRoot, node.relativePath));
      item.resourceUri = uri;
      item.command = {
        command: "vscode.open",
        title: "Open changed file",
        arguments: [uri],
      };
      item.contextValue = "intentLoop.changedFile";
      return item;
    }

    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
    item.iconPath = new vscode.ThemeIcon(node.icon);
    return item;
  }

  public getChildren(node?: OverviewNode): OverviewNode[] {
    const snapshot = this.getSnapshot();
    if (snapshot.kind === "unavailable") {
      return node ? [] : [{ kind: "message", label: snapshot.reason, icon: "info" }];
    }

    if (node?.kind === "changed-files") {
      return snapshot.state.changedPaths.map((relativePath) => ({
        kind: "file",
        relativePath,
        repositoryRoot: snapshot.state.repositoryRoot,
      }));
    }

    if (node) {
      return [];
    }

    const state = snapshot.state;
    return [
      {
        kind: "message",
        label: state.paused ? "Observation paused" : "Observation active",
        description: state.baselineCommit.slice(0, 12),
        icon: state.paused ? "debug-pause" : "pulse",
      },
      { kind: "changed-files", count: state.changedPaths.length },
    ];
  }
}
