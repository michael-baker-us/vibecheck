import * as path from "node:path";

import * as vscode from "vscode";

import { ObservationSnapshot } from "../domain/observation-state";

export class FindingDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection("intent-loop");

  public render(snapshot: ObservationSnapshot): void {
    this.collection.clear();
    if (snapshot.kind !== "ready") return;
    const grouped = new Map<string, vscode.Diagnostic[]>();
    for (const finding of snapshot.state.findings.filter((item) => item.status === "open")) {
      for (const evidence of finding.evidence.filter((item) => item.path && item.line)) {
        const absolutePath = path.join(snapshot.state.repositoryRoot, evidence.path!);
        const line = Math.max(0, (evidence.line ?? 1) - 1);
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
          `${finding.title}: ${finding.explanation}`,
          finding.severity === "high"
            ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Information,
        );
        diagnostic.source = "VibeCheck";
        diagnostic.code = finding.ruleId;
        const existing = grouped.get(absolutePath) ?? [];
        existing.push(diagnostic);
        grouped.set(absolutePath, existing);
      }
    }
    for (const [absolutePath, diagnostics] of grouped) {
      this.collection.set(vscode.Uri.file(absolutePath), diagnostics);
    }
  }

  public dispose(): void {
    this.collection.dispose();
  }
}
