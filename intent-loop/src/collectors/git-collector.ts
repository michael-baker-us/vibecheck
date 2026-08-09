import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import { ChangedFile, FileChangeStatus } from "../domain/observation-state";

const execFileAsync = promisify(execFile);
const MAX_TEXT_BYTES = 512 * 1024;

export type RepositoryIdentity = {
  root: string;
  head: string;
};

type ChangedPath = {
  path: string;
  previousPath?: string;
  status: FileChangeStatus;
};

export class GitCollector {
  public async discover(workspaceRoot: string): Promise<RepositoryIdentity> {
    const root = (await this.run(["rev-parse", "--show-toplevel"], workspaceRoot)).trim();

    let head: string;
    try {
      head = (await this.run(["rev-parse", "--verify", "HEAD"], root)).trim();
    } catch {
      throw new Error("Intent Loop requires a repository with at least one commit.");
    }

    return { root, head };
  }

  public async collectChanges(repositoryRoot: string, baselineCommit: string): Promise<ChangedFile[]> {
    const [trackedOutput, untrackedOutput] = await Promise.all([
      this.run(["diff", "--name-status", "-z", baselineCommit, "--"], repositoryRoot),
      this.run(["ls-files", "--others", "--exclude-standard", "-z"], repositoryRoot),
    ]);

    const changed = this.parseNameStatus(trackedOutput);
    for (const untrackedPath of this.parseNullSeparated(untrackedOutput)) {
      if (!changed.some((item) => item.path === untrackedPath)) {
        changed.push({ path: untrackedPath, status: "added" });
      }
    }

    const details = await Promise.all(
      changed.map(async (item): Promise<ChangedFile> => {
        const [before, after] = await Promise.all([
          item.status === "added"
            ? Promise.resolve(undefined)
            : this.readAtRevision(repositoryRoot, baselineCommit, item.previousPath ?? item.path),
          item.status === "deleted"
            ? Promise.resolve(undefined)
            : this.readWorkingFile(repositoryRoot, item.path),
        ]);
        return {
          ...item,
          binary: before?.binary === true || after?.binary === true,
          before: before?.text,
          after: after?.text,
        };
      }),
    );

    return details.sort((left, right) => left.path.localeCompare(right.path));
  }

  public async listRepositoryFiles(repositoryRoot: string): Promise<string[]> {
    const output = await this.run(
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      repositoryRoot,
    );
    return this.parseNullSeparated(output).sort((left, right) => left.localeCompare(right));
  }

  public async readWorkingText(repositoryRoot: string, relativePath: string): Promise<string | undefined> {
    return (await this.readWorkingFile(repositoryRoot, relativePath))?.text;
  }

  public async getDiff(repositoryRoot: string, baselineCommit: string, relativePath?: string): Promise<string> {
    const args = ["diff", "--no-ext-diff", "--unified=3", baselineCommit, "--"];
    if (relativePath) {
      args.push(relativePath);
    }
    return this.run(args, repositoryRoot);
  }

  private parseNameStatus(output: string): ChangedPath[] {
    const tokens = this.parseNullSeparated(output);
    const result: ChangedPath[] = [];

    for (let index = 0; index < tokens.length; ) {
      const code = tokens[index++];
      if (!code) {
        break;
      }

      if (code.startsWith("R") || code.startsWith("C")) {
        const previousPath = tokens[index++];
        const currentPath = tokens[index++];
        if (previousPath && currentPath) {
          result.push({ path: currentPath, previousPath, status: "renamed" });
        }
        continue;
      }

      const changedPath = tokens[index++];
      if (changedPath) {
        result.push({ path: changedPath, status: this.mapStatus(code) });
      }
    }

    return result;
  }

  private mapStatus(code: string): FileChangeStatus {
    if (code.startsWith("A")) return "added";
    if (code.startsWith("D")) return "deleted";
    return "modified";
  }

  private parseNullSeparated(output: string): string[] {
    return output.split("\0").filter(Boolean);
  }

  private async readAtRevision(
    repositoryRoot: string,
    revision: string,
    relativePath: string,
  ): Promise<{ text?: string; binary: boolean } | undefined> {
    try {
      const content = await this.runBuffer(["show", `${revision}:${relativePath}`], repositoryRoot);
      return this.asText(content);
    } catch {
      return undefined;
    }
  }

  private async readWorkingFile(
    repositoryRoot: string,
    relativePath: string,
  ): Promise<{ text?: string; binary: boolean } | undefined> {
    const absolutePath = path.resolve(repositoryRoot, relativePath);
    const relative = path.relative(repositoryRoot, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return undefined;
    }

    try {
      return this.asText(await readFile(absolutePath));
    } catch {
      return undefined;
    }
  }

  private asText(content: Buffer): { text?: string; binary: boolean } {
    if (content.length > MAX_TEXT_BYTES || content.includes(0)) {
      return { binary: true };
    }
    return { text: content.toString("utf8"), binary: false };
  }

  private async run(args: string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout;
  }

  private async runBuffer(args: string[], cwd: string): Promise<Buffer> {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "buffer",
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout;
  }
}
