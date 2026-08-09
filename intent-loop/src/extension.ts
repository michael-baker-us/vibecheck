import * as vscode from "vscode";

import { GitCollector } from "./collectors/git-collector";
import { ObservationController } from "./observation-controller";
import { WorkspaceStore } from "./storage/workspace-store";
import { OverviewTreeProvider } from "./ui/overview-tree";
import { IntentLoopStatusBar } from "./ui/status-bar";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Intent Loop", { log: true });
  context.subscriptions.push(output);

  const workspaceFolder = selectWorkspaceFolder();
  if (!workspaceFolder) {
    output.appendLine("Intent Loop requires an open workspace folder.");
    return;
  }

  const store = new WorkspaceStore(context.workspaceState);
  const statusBar = new IntentLoopStatusBar();
  let controller: ObservationController;

  const overview = new OverviewTreeProvider(() => controller.getSnapshot());
  controller = new ObservationController(
    workspaceFolder,
    store,
    new GitCollector(),
    () => {
      overview.refresh();
      statusBar.render(controller.getSnapshot());
    },
    output,
  );

  context.subscriptions.push(
    statusBar,
    controller,
    vscode.window.registerTreeDataProvider("intentLoop.overview", overview),
    vscode.commands.registerCommand("intentLoop.start", async () => {
      await controller.resume();
    }),
    vscode.commands.registerCommand("intentLoop.pause", async () => {
      await controller.pause();
    }),
    vscode.commands.registerCommand("intentLoop.refresh", async () => {
      await controller.refresh();
    }),
    vscode.commands.registerCommand("intentLoop.reset", async () => {
      const choice = await vscode.window.showWarningMessage(
        "Reset the Intent Loop baseline to the repository's current HEAD? Uncommitted changes will still appear.",
        { modal: true },
        "Reset to HEAD",
      );
      if (choice === "Reset to HEAD") {
        await controller.reset();
      }
    }),
    vscode.commands.registerCommand("intentLoop.deleteData", async () => {
      const choice = await vscode.window.showWarningMessage(
        "Delete this workspace's local Intent Loop observation state?",
        { modal: true },
        "Delete Local Data",
      );
      if (choice === "Delete Local Data") {
        await controller.deleteData();
      }
    }),
  );

  statusBar.render(controller.getSnapshot());
  await controller.initialize();
}

export function deactivate(): void {
  // Disposables registered with the extension context are released by VS Code.
}

function selectWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }

  if (folders.length > 1) {
    void vscode.window.showInformationMessage(
      `Intent Loop M0 is observing the first workspace folder: ${folders[0].name}.`,
    );
  }

  return folders[0];
}
