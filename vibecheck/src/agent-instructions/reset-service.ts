import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";

export type AgentWorkspaceResetResult = {
  removedFiles: string[];
  backupDirectory?: string;
};

export class AgentWorkspaceResetService {
  public async reset(
    repositoryRoot: string,
    relativePaths: string[],
    backupRoot: string,
  ): Promise<AgentWorkspaceResetResult> {
    const files = await Promise.all([...new Set(relativePaths)].sort().map(async (relativePath) => {
      const absolutePath = this.resolveRepositoryFile(repositoryRoot, relativePath);
      let stats;
      try {
        stats = await lstat(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`${relativePath} is not a regular repository file and was not removed.`);
      }
      return { relativePath, absolutePath, content: await readFile(absolutePath) };
    }));
    const existing = files.filter((file): file is NonNullable<typeof file> => file !== undefined);
    if (!existing.length) return { removedFiles: [] };

    const backupDirectory = path.join(backupRoot, String(Date.now()));
    for (const file of existing) {
      const backupPath = path.join(backupDirectory, file.relativePath);
      await mkdir(path.dirname(backupPath), { recursive: true });
      await writeFile(backupPath, file.content);
    }

    for (const file of existing) {
      const current = await readFile(file.absolutePath);
      if (!current.equals(file.content)) {
        throw new Error(`${file.relativePath} changed while the reset was being prepared and was not removed.`);
      }
    }
    for (const file of existing) await unlink(file.absolutePath);
    return { removedFiles: existing.map((file) => file.relativePath), backupDirectory };
  }

  private resolveRepositoryFile(repositoryRoot: string, relativePath: string): string {
    const absolutePath = path.resolve(repositoryRoot, relativePath);
    const relative = path.relative(repositoryRoot, absolutePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Invalid Agent Workspace path: ${relativePath}`);
    }
    return absolutePath;
  }
}
