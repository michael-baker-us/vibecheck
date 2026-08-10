/**
 * Package managers VibeCheck can install a recommended gate's dependencies with.
 *
 * Adding an ecosystem is a data change here, not a code change anywhere else. Each entry owns the
 * files that identify it and the argument vector for a development-dependency install.
 *
 * Nothing in this module ever builds a shell string. `devInstall` returns an argv array that is
 * spawned without a shell, so a package name can never be interpreted as a command, a redirect, or
 * a separator no matter what an agent proposed.
 */

export type PackageManagerId = "npm" | "yarn" | "pnpm" | "bun" | "poetry" | "uv" | "cargo" | "go" | "bundler";

export type PackageManager = {
  id: PackageManagerId;
  label: string;
  /** Files whose presence identifies this manager, most specific first. */
  markers: string[];
  devInstall(packages: string[]): string[];
};

export const PACKAGE_MANAGERS: PackageManager[] = [
  {
    id: "bun",
    label: "Bun",
    markers: ["bun.lockb", "bun.lock"],
    devInstall: (packages) => ["bun", "add", "--dev", ...packages],
  },
  {
    id: "pnpm",
    label: "pnpm",
    markers: ["pnpm-lock.yaml"],
    devInstall: (packages) => ["pnpm", "add", "--save-dev", ...packages],
  },
  {
    id: "yarn",
    label: "Yarn",
    markers: ["yarn.lock"],
    devInstall: (packages) => ["yarn", "add", "--dev", ...packages],
  },
  {
    id: "npm",
    label: "npm",
    markers: ["package-lock.json", "npm-shrinkwrap.json", "package.json"],
    devInstall: (packages) => ["npm", "install", "--save-dev", ...packages],
  },
  {
    id: "poetry",
    label: "Poetry",
    markers: ["poetry.lock"],
    devInstall: (packages) => ["poetry", "add", "--group", "dev", ...packages],
  },
  {
    id: "uv",
    label: "uv",
    markers: ["uv.lock"],
    devInstall: (packages) => ["uv", "add", "--dev", ...packages],
  },
  {
    id: "cargo",
    label: "Cargo",
    markers: ["Cargo.lock", "Cargo.toml"],
    devInstall: (packages) => ["cargo", "add", "--dev", ...packages],
  },
  {
    id: "bundler",
    label: "Bundler",
    markers: ["Gemfile.lock", "Gemfile"],
    devInstall: (packages) => ["bundle", "add", "--group", "development", ...packages],
  },
  {
    id: "go",
    label: "Go modules",
    markers: ["go.sum", "go.mod"],
    devInstall: (packages) => ["go", "get", ...packages],
  },
];

export const PACKAGE_MANAGER_IDS = PACKAGE_MANAGERS.map((manager) => manager.id);

export function packageManager(id: PackageManagerId): PackageManager | undefined {
  return PACKAGE_MANAGERS.find((manager) => manager.id === id);
}

/**
 * Picks the manager whose marker files exist, preferring lockfiles over bare manifests so a
 * repository with both `package.json` and `pnpm-lock.yaml` resolves to pnpm.
 */
export function detectPackageManager(files: (file: string) => boolean): PackageManager | undefined {
  for (const rank of [0, 1]) {
    for (const manager of PACKAGE_MANAGERS) {
      const markers = rank === 0 ? manager.markers.filter(isLockfile) : manager.markers;
      if (markers.some((marker) => files(marker))) return manager;
    }
  }
  return undefined;
}

function isLockfile(marker: string): boolean {
  return /lock/i.test(marker);
}

/**
 * Accepts a dependency token for any ecosystem while refusing anything that could act as an
 * option rather than a package. Leading dashes are the real hazard: argv is not shell-parsed, so
 * `--force` would still reach the package manager as a flag.
 */
export function isSafePackageToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 214
    && !/^-/.test(value)
    && !/[\s;|&$`<>(){}[\]\\'"]/.test(value)
    && !value.includes("..");
}
