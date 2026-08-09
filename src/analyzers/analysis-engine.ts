import { createHash } from "node:crypto";
import * as path from "node:path";

import { minimatch } from "minimatch";

import { VibeCheckConfiguration } from "../domain/configuration";
import { Finding, FindingCandidate } from "../domain/findings";
import { ChangedFile } from "../domain/observation-state";

const TEST_FILE = /(^|\/)(__tests__\/|tests?\/|[^/]+\.(test|spec)\.[^/]+$)/i;
const GENERATED_PATH = /(^|\/)(dist|build|coverage|generated|vendor)(\/|$)/i;
const BINARY_EXTENSION = /\.(png|jpe?g|gif|webp|ico|pdf|zip|tar|gz|wasm|woff2?|ttf|mp[34]|mov)$/i;
const SENSITIVE_PATHS: Array<{ pattern: RegExp; label: string; severity: "medium" | "high" }> = [
  { pattern: /(^|\/)\.github\/workflows\//, label: "CI workflow", severity: "medium" },
  { pattern: /(^|\/)(auth|authentication)(\/|\.|$)/i, label: "authentication", severity: "high" },
  { pattern: /(^|\/)(migrations?|schema)(\/|\.|$)/i, label: "database migration", severity: "high" },
  { pattern: /(^|\/)(terraform|infra|deploy|k8s|kubernetes)(\/|\.|$)/i, label: "infrastructure", severity: "high" },
  { pattern: /(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml)$/i, label: "container", severity: "medium" },
  { pattern: /(^|\/)\.env(\.|$)/i, label: "environment configuration", severity: "high" },
];

export class AnalysisEngine {
  public analyze(
    changedFiles: ChangedFile[],
    configuration: VibeCheckConfiguration,
    previousFindings: Finding[],
    now = new Date().toISOString(),
  ): Finding[] {
    const candidates = [
      ...this.dependencies(changedFiles),
      ...this.testIntegrity(changedFiles),
      ...this.sensitiveFiles(changedFiles),
      ...this.generatedAndBinary(changedFiles),
      ...this.diffExpansion(changedFiles, configuration.diffExpansionThreshold),
      ...this.boundaries(changedFiles, configuration),
    ];

    return this.reconcile(candidates, previousFindings, now);
  }

  private dependencies(changes: ChangedFile[]): FindingCandidate[] {
    const manifest = changes.find((change) => change.path === "package.json");
    if (!manifest?.after) return [];

    try {
      const before = manifest.before ? JSON.parse(manifest.before) : {};
      const after = JSON.parse(manifest.after);
      const beforeDependencies = this.stringRecord(before.dependencies);
      const afterDependencies = this.stringRecord(after.dependencies);

      return Object.entries(afterDependencies)
        .filter(([name, version]) => beforeDependencies[name] !== version)
        .map(([name, version]) => ({
          ruleId: "dependency.runtime-added",
          title: beforeDependencies[name] ? `Runtime dependency changed: ${name}` : `Runtime dependency added: ${name}`,
          explanation: beforeDependencies[name]
            ? `${name} changed from ${beforeDependencies[name]} to ${version}.`
            : `${name}@${version} was added to runtime dependencies.`,
          severity: "medium" as const,
          basis: "fact" as const,
          evidence: [{ path: "package.json", detail: `${name}: ${version}` }],
          fingerprintParts: [name, version],
        }));
    } catch {
      return [];
    }
  }

  private testIntegrity(changes: ChangedFile[]): FindingCandidate[] {
    const findings: FindingCandidate[] = [];
    const focusPatterns = [
      /\b(?:describe|it|test)\.only\s*\(/g,
      /\b(?:describe|it|test)\.skip\s*\(/g,
      /\b(?:xdescribe|xit|xtest)\s*\(/g,
      /@pytest\.mark\.skip\b/g,
    ];

    for (const change of changes.filter((item) => TEST_FILE.test(item.path))) {
      if (change.status === "deleted") {
        findings.push({
          ruleId: "test.deleted",
          title: "Test file deleted",
          explanation: `${change.path} was removed relative to the current commit.`,
          severity: "high",
          basis: "fact",
          evidence: [{ path: change.path, detail: "Deleted test file" }],
          fingerprintParts: [change.path],
        });
        continue;
      }

      const before = change.before ?? "";
      const after = change.after ?? "";
      const executableBefore = this.stripStringsAndComments(before);
      const executableAfter = this.stripStringsAndComments(after);
      const addedFocusCount = focusPatterns.reduce(
        (total, pattern) =>
          total +
          Math.max(0, this.count(executableAfter, pattern) - this.count(executableBefore, pattern)),
        0,
      );
      if (addedFocusCount > 0) {
        findings.push({
          ruleId: "test.excluded-or-focused",
          title: "Test exclusion or focus added",
          explanation: `${change.path} gained ${addedFocusCount} focused or skipped test marker${addedFocusCount === 1 ? "" : "s"}.`,
          severity: "high",
          basis: "fact",
          evidence: [{ path: change.path, detail: "New skip/focus marker" }],
          fingerprintParts: [change.path, String(addedFocusCount)],
        });
      }

      const assertionsBefore = this.countAssertions(before);
      const assertionsAfter = this.countAssertions(after);
      if (assertionsAfter < assertionsBefore) {
        findings.push({
          ruleId: "test.assertions-removed",
          title: "Existing assertions were removed",
          explanation: `${change.path} contains ${assertionsBefore - assertionsAfter} fewer recognizable assertion${assertionsBefore - assertionsAfter === 1 ? "" : "s"}.`,
          severity: "medium",
          basis: "heuristic",
          evidence: [{ path: change.path, detail: `${assertionsBefore} → ${assertionsAfter} assertions` }],
          fingerprintParts: [change.path, String(assertionsBefore), String(assertionsAfter)],
        });
      }
    }

    return findings;
  }

  private sensitiveFiles(changes: ChangedFile[]): FindingCandidate[] {
    return changes.flatMap((change) =>
      SENSITIVE_PATHS.filter(({ pattern }) => pattern.test(change.path)).map(({ label, severity }) => ({
        ruleId: "change.sensitive-file",
        title: `${this.capitalize(label)} change requires review`,
        explanation: `${change.path} is ${label}-related and changed during this observation.`,
        severity,
        basis: "fact" as const,
        evidence: [{ path: change.path, detail: `${change.status} ${label} file` }],
        fingerprintParts: [change.path, label],
      })),
    );
  }

  private generatedAndBinary(changes: ChangedFile[]): FindingCandidate[] {
    return changes
      .filter(
        (change) =>
          change.status === "added" &&
          (change.binary || BINARY_EXTENSION.test(change.path) || GENERATED_PATH.test(change.path)),
      )
      .map((change) => ({
        ruleId: "change.generated-or-binary",
        title: change.binary || BINARY_EXTENSION.test(change.path) ? "Binary file added" : "Generated file added",
        explanation: `${change.path} entered the diff and may not belong in source control.`,
        severity: "medium" as const,
        basis: "fact" as const,
        evidence: [{ path: change.path, detail: "Added file" }],
        fingerprintParts: [change.path],
      }));
  }

  private diffExpansion(changes: ChangedFile[], threshold: number): FindingCandidate[] {
    if (changes.length <= threshold) return [];
    return [
      {
        ruleId: "scope.diff-expansion",
        title: "Diff has expanded broadly",
        explanation: `${changes.length} files differ from the current commit; the configured threshold is ${threshold}.`,
        severity: "medium",
        basis: "heuristic",
        evidence: [{ detail: `${changes.length} changed files` }],
        fingerprintParts: [String(threshold)],
      },
    ];
  }

  private boundaries(
    changes: ChangedFile[],
    configuration: VibeCheckConfiguration,
  ): FindingCandidate[] {
    const findings: FindingCandidate[] = [];
    for (const change of changes) {
      if (!change.after || !/\.[cm]?[jt]sx?$/.test(change.path)) continue;
      for (const rule of configuration.boundaries) {
        if (!minimatch(change.path, rule.from, { dot: true })) continue;
        for (const imported of this.extractImports(change.after)) {
          const resolved = this.resolveImport(change.path, imported.specifier);
          if (!resolved) continue;
          const forbidden = rule.cannotImport.find((glob) => this.matchesModule(resolved, glob));
          if (!forbidden) continue;
          findings.push({
            ruleId: `architecture.boundary.${rule.name}`,
            title: `Architecture boundary crossed: ${rule.name}`,
            explanation: `${change.path} imports ${imported.specifier}, which resolves inside ${forbidden}.`,
            severity: "high",
            basis: "configured-rule",
            evidence: [{ path: change.path, line: imported.line, detail: `Imports ${imported.specifier}` }],
            fingerprintParts: [rule.name, change.path, imported.specifier],
          });
        }
      }
    }
    return findings;
  }

  private reconcile(candidates: FindingCandidate[], previous: Finding[], now: string): Finding[] {
    const priorByFingerprint = new Map(previous.map((finding) => [finding.fingerprint, finding]));
    const active = candidates.map((candidate): Finding => {
      const fingerprint = this.fingerprint(candidate.ruleId, candidate.fingerprintParts);
      const prior = priorByFingerprint.get(fingerprint);
      return {
        ...candidate,
        id: fingerprint.slice(0, 16),
        fingerprint,
        status:
          prior?.status === "accepted" || prior?.status === "dismissed" ? prior.status : "open",
        firstObservedAt: prior?.firstObservedAt ?? now,
        lastObservedAt: now,
      };
    });

    const activeFingerprints = new Set(active.map((finding) => finding.fingerprint));
    const resolved = previous
      .filter((finding) => !activeFingerprints.has(finding.fingerprint))
      .map((finding) => ({ ...finding, status: "resolved" as const, lastObservedAt: now }))
      .slice(-50);
    return [...active, ...resolved];
  }

  private fingerprint(ruleId: string, parts: string[]): string {
    return createHash("sha256").update([ruleId, ...parts].join("\0")).digest("hex");
  }

  private stringRecord(value: unknown): Record<string, string> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }

  private count(value: string, pattern: RegExp): number {
    return value.match(new RegExp(pattern.source, pattern.flags))?.length ?? 0;
  }

  private countAssertions(value: string): number {
    return (
      this.count(value, /\bexpect\s*\(/g) +
      this.count(value, /\bassert(?:\.|\s*\()/g) +
      this.count(value, /\bshould(?:\.|\s*\()/g)
    );
  }

  private stripStringsAndComments(value: string): string {
    return value.replace(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
      (match) => "\n".repeat((match.match(/\n/g) ?? []).length),
    );
  }

  private extractImports(source: string): Array<{ specifier: string; line: number }> {
    const expression = /(?:\bfrom\s*|\brequire\s*\(|\bimport\s*(?:\(|))\s*["']([^"']+)["']/g;
    const imports: Array<{ specifier: string; line: number }> = [];
    for (const match of source.matchAll(expression)) {
      imports.push({
        specifier: match[1],
        line: source.slice(0, match.index).split("\n").length,
      });
    }
    return imports;
  }

  private resolveImport(sourcePath: string, specifier: string): string | undefined {
    if (!specifier.startsWith(".")) return undefined;
    return path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier));
  }

  private matchesModule(resolved: string, glob: string): boolean {
    const candidates = [
      resolved,
      `${resolved}.ts`,
      `${resolved}.tsx`,
      `${resolved}.js`,
      `${resolved}.jsx`,
      `${resolved}/index.ts`,
      `${resolved}/index.js`,
    ];
    return candidates.some((candidate) => minimatch(candidate, glob, { dot: true }));
  }

  private capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }
}
