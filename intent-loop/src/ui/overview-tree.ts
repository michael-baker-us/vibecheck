import * as path from "node:path";

import * as vscode from "vscode";

import { Finding } from "../domain/findings";
import { ObservationSnapshot } from "../domain/observation-state";
import { VerificationState } from "../domain/verification";

export type OverviewNode =
  | { kind: "message"; label: string; description?: string; icon: string; command?: string }
  | { kind: "group"; group: "attention" | "verification" | "changes" | "history"; count: number }
  | { kind: "finding"; finding: Finding }
  | { kind: "verification"; verification: VerificationState }
  | { kind: "file"; relativePath: string; repositoryRoot: string; status: string };

export class OverviewTreeProvider implements vscode.TreeDataProvider<OverviewNode> {
  private readonly changedEmitter = new vscode.EventEmitter<OverviewNode | undefined>();
  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor(
    private readonly getSnapshot: () => ObservationSnapshot,
    private readonly getConfigurationError: () => string | undefined,
  ) {}

  public refresh(): void {
    this.changedEmitter.fire(undefined);
  }

  public getTreeItem(node: OverviewNode): vscode.TreeItem {
    if (node.kind === "group") {
      const labels = {
        attention: "Needs attention",
        verification: "Verification",
        changes: "Changed files",
        history: "Resolved / dismissed",
      };
      const item = new vscode.TreeItem(labels[node.group], vscode.TreeItemCollapsibleState.Expanded);
      item.description = String(node.count);
      item.iconPath = new vscode.ThemeIcon(
        node.group === "attention" ? "warning" : node.group === "verification" ? "beaker" : "files",
      );
      return item;
    }
    if (node.kind === "finding") {
      const item = new vscode.TreeItem(node.finding.title, vscode.TreeItemCollapsibleState.None);
      item.description = `${node.finding.severity} · ${node.finding.basis}`;
      item.tooltip = new vscode.MarkdownString(
        `**${node.finding.title}**\n\n${node.finding.explanation}\n\nBasis: ${node.finding.basis}`,
      );
      item.iconPath = new vscode.ThemeIcon(
        node.finding.status === "open"
          ? node.finding.severity === "high"
            ? "error"
            : "warning"
          : node.finding.status === "accepted"
            ? "pass"
            : "circle-slash",
      );
      item.contextValue = `intentLoop.finding.${node.finding.status}`;
      item.command = {
        command: "intentLoop.inspectFinding",
        title: "Inspect finding",
        arguments: [node.finding],
      };
      return item;
    }
    if (node.kind === "verification") {
      const icons: Record<VerificationState["status"], string> = {
        "not-run": "circle-outline",
        running: "loading~spin",
        passed: "pass-filled",
        failed: "error",
        stale: "history",
      };
      const item = new vscode.TreeItem(node.verification.name, vscode.TreeItemCollapsibleState.None);
      item.description = node.verification.status;
      item.tooltip = `${node.verification.command}${node.verification.output ? `\n\n${node.verification.output.slice(-4000)}` : ""}`;
      item.iconPath = new vscode.ThemeIcon(icons[node.verification.status]);
      item.contextValue = "intentLoop.verification";
      item.command = {
        command: "intentLoop.runVerification",
        title: "Run verification",
        arguments: [node.verification.name],
      };
      return item;
    }
    if (node.kind === "file") {
      const item = new vscode.TreeItem(node.relativePath, vscode.TreeItemCollapsibleState.None);
      const uri = vscode.Uri.file(path.join(node.repositoryRoot, node.relativePath));
      item.resourceUri = uri;
      item.description = node.status;
      item.command = { command: "vscode.open", title: "Open changed file", arguments: [uri] };
      return item;
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
    item.iconPath = new vscode.ThemeIcon(node.icon);
    if (node.command) item.command = { command: node.command, title: node.label };
    return item;
  }

  public getChildren(node?: OverviewNode): OverviewNode[] {
    const snapshot = this.getSnapshot();
    if (snapshot.kind === "unavailable") {
      return node ? [] : [{ kind: "message", label: snapshot.reason, icon: "info" }];
    }
    const state = snapshot.state;
    if (node?.kind === "group") {
      if (node.group === "attention") {
        return state.findings.filter((finding) => finding.status === "open").map((finding) => ({ kind: "finding", finding }));
      }
      if (node.group === "history") {
        return state.findings.filter((finding) => finding.status !== "open").map((finding) => ({ kind: "finding", finding }));
      }
      if (node.group === "verification") {
        return state.verification.map((verification) => ({ kind: "verification", verification }));
      }
      return state.changedFiles.map((file) => ({
        kind: "file",
        relativePath: file.path,
        repositoryRoot: state.repositoryRoot,
        status: file.status,
      }));
    }
    if (node) return [];

    const openCount = state.findings.filter((finding) => finding.status === "open").length;
    const historyCount = state.findings.length - openCount;
    const roots: OverviewNode[] = [
      {
        kind: "message",
        label: state.workingIntent || "Set working intent",
        description: state.workingIntent ? "intent" : undefined,
        icon: "target",
        command: "intentLoop.setIntent",
      },
      {
        kind: "message",
        label: state.paused ? "Observation paused" : "Observation active",
        description: state.baselineCommit.slice(0, 12),
        icon: state.paused ? "debug-pause" : "pulse",
      },
    ];
    if (state.agent.connectedAgents.length > 0 || state.agent.lastEventAt) {
      roots.push({
        kind: "message",
        label:
          state.agent.connectedAgents.length > 0
            ? `Agent connected: ${state.agent.connectedAgents.join(", ")}`
            : "Agent session ended",
        description: state.agent.lastEventType,
        icon: "hubot",
      });
    }
    const configurationError = this.getConfigurationError();
    if (configurationError) {
      roots.push({ kind: "message", label: "Configuration error", description: configurationError, icon: "error" });
    }
    roots.push(
      { kind: "group", group: "attention", count: openCount },
      { kind: "group", group: "verification", count: state.verification.length },
      { kind: "group", group: "changes", count: state.changedFiles.length },
    );
    if (historyCount > 0) roots.push({ kind: "group", group: "history", count: historyCount });
    return roots;
  }
}
