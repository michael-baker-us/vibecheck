import * as vscode from "vscode";

import { InstructionFilePath, InstructionRefreshProposal } from "../domain/instruction-refresh";

export const INSTRUCTION_PREVIEW_SCHEME = "vibecheck-instruction-preview";

export class InstructionPreviewProvider implements vscode.TextDocumentContentProvider {
  private proposal: InstructionRefreshProposal | undefined;
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();

  public readonly onDidChange = this.changed.event;

  public setProposal(proposal: InstructionRefreshProposal | undefined): void {
    const previousPaths = this.proposal?.files.map((file) => file.path) ?? [];
    this.proposal = proposal;
    const paths = new Set<InstructionFilePath>([
      ...previousPaths,
      ...(proposal?.files.map((file) => file.path) ?? []),
    ]);
    for (const file of paths) {
      this.changed.fire(this.uri("original", file));
      this.changed.fire(this.uri("proposed", file));
    }
  }

  public uri(side: "original" | "proposed", file: InstructionFilePath): vscode.Uri {
    return vscode.Uri.from({ scheme: INSTRUCTION_PREVIEW_SCHEME, authority: side, path: `/${file}` });
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    const file = uri.path.slice(1) as InstructionFilePath;
    const proposal = this.proposal?.files.find((entry) => entry.path === file);
    if (!proposal) return "";
    return uri.authority === "original" ? proposal.originalContent ?? "" : proposal.proposedContent;
  }

  public dispose(): void {
    this.changed.dispose();
  }
}
