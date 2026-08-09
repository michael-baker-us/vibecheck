import { VerificationCategory } from "../domain/configuration";
import {
  CoverageSummary,
  SecuritySummary,
  TestSummary,
  VerificationSummary,
} from "../domain/verification";

export function parseVerificationSummary(
  category: VerificationCategory,
  output: string,
  previous?: VerificationSummary,
): VerificationSummary | undefined {
  if (category === "tests") return parseTests(output);
  if (category === "coverage") return parseCoverage(output, previous);
  if (category === "security") return parseSecurity(output, previous);
  return undefined;
}

function parseTests(output: string): TestSummary | undefined {
  const tap = {
    total: lastInteger(output, /^# tests\s+(\d+)\s*$/gm),
    passed: lastInteger(output, /^# pass\s+(\d+)\s*$/gm),
    failed: lastInteger(output, /^# fail\s+(\d+)\s*$/gm),
    skipped: lastInteger(output, /^# skipped\s+(\d+)\s*$/gm) ?? 0,
  };
  if (tap.total !== undefined && tap.passed !== undefined && tap.failed !== undefined) {
    return { kind: "tests", ...tap } as TestSummary;
  }

  const jestLine = [...output.matchAll(/^Tests:\s+(.+)$/gm)].at(-1)?.[1];
  if (!jestLine) return undefined;
  const total = firstInteger(jestLine, /(\d+)\s+total/);
  const passed = firstInteger(jestLine, /(\d+)\s+passed/) ?? 0;
  const failed = firstInteger(jestLine, /(\d+)\s+failed/) ?? 0;
  const skipped = firstInteger(jestLine, /(\d+)\s+(?:skipped|pending)/) ?? 0;
  return total === undefined ? undefined : { kind: "tests", total, passed, failed, skipped };
}

function parseCoverage(output: string, previous?: VerificationSummary): CoverageSummary | undefined {
  const allFiles = [...output.matchAll(/^All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/gm)].at(-1);
  let values: Omit<CoverageSummary, "kind" | "change"> | undefined;
  if (allFiles) {
    values = {
      statements: Number(allFiles[1]),
      branches: Number(allFiles[2]),
      functions: Number(allFiles[3]),
      lines: Number(allFiles[4]),
    };
  } else {
    const json = parseJsonObject(output);
    const total = record(record(json, "total"), "lines");
    const lines = finiteNumber(total?.pct);
    if (lines !== undefined) {
      values = {
        lines,
        statements: metricPercentage(json, "statements"),
        branches: metricPercentage(json, "branches"),
        functions: metricPercentage(json, "functions"),
      };
    }
  }
  if (!values) return undefined;
  const prior = previous?.kind === "coverage" ? previous.lines : undefined;
  return {
    kind: "coverage",
    ...values,
    ...(prior === undefined ? {} : { change: round(values.lines - prior) }),
  };
}

function parseSecurity(output: string, previous?: VerificationSummary): SecuritySummary | undefined {
  const json = parseJsonObject(output);
  const metadataCounts = record(record(json, "metadata"), "vulnerabilities");
  const vulnerabilities = record(json, "vulnerabilities");
  if (metadataCounts) {
    const counts = securityCounts(metadataCounts);
    const issueIds = vulnerabilities ? Object.keys(vulnerabilities).sort() : undefined;
    const changes = securityChanges(counts.total, issueIds, previous);
    return { kind: "security", ...counts, ...changes, ...(issueIds ? { issueIds } : {}) };
  }

  if (/found\s+0\s+vulnerabilit(?:y|ies)/i.test(output)) {
    const counts = { total: 0, critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
    return { kind: "security", ...counts, ...securityChanges(0, undefined, previous) };
  }
  const summary = [...output.matchAll(/(\d+)\s+vulnerabilities?\s*\(([^)]+)\)/gi)].at(-1);
  if (!summary) return undefined;
  const counts = { total: Number(summary[1]), critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
  for (const severity of ["critical", "high", "moderate", "low", "info"] as const) {
    counts[severity] = firstInteger(summary[2], new RegExp(`(\\d+)\\s+${severity}`)) ?? 0;
  }
  return { kind: "security", ...counts, ...securityChanges(counts.total, undefined, previous) };
}

function securityCounts(value: Record<string, unknown>): Omit<SecuritySummary, "kind" | "newIssues" | "fixedIssues" | "issueIds"> {
  const critical = finiteNumber(value.critical) ?? 0;
  const high = finiteNumber(value.high) ?? 0;
  const moderate = finiteNumber(value.moderate) ?? 0;
  const low = finiteNumber(value.low) ?? 0;
  const info = finiteNumber(value.info) ?? 0;
  return { total: finiteNumber(value.total) ?? critical + high + moderate + low + info, critical, high, moderate, low, info };
}

function securityChanges(total: number, issueIds: string[] | undefined, previous?: VerificationSummary): Pick<SecuritySummary, "newIssues" | "fixedIssues"> {
  if (previous?.kind !== "security") return { newIssues: 0, fixedIssues: 0 };
  if (issueIds && previous.issueIds) {
    const current = new Set(issueIds);
    const prior = new Set(previous.issueIds);
    return {
      newIssues: issueIds.filter((id) => !prior.has(id)).length,
      fixedIssues: previous.issueIds.filter((id) => !current.has(id)).length,
    };
  }
  return { newIssues: Math.max(0, total - previous.total), fixedIssues: Math.max(0, previous.total - total) };
}

function metricPercentage(value: Record<string, unknown> | undefined, name: string): number | undefined {
  return finiteNumber(record(record(value, "total"), name)?.pct);
}

function parseJsonObject(output: string): Record<string, unknown> | undefined {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return record(JSON.parse(output.slice(start, end + 1)));
  } catch {
    return undefined;
  }
}

function record(value: unknown, key?: string): Record<string, unknown> | undefined {
  const selected = key && value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : value;
  return selected && typeof selected === "object" && !Array.isArray(selected)
    ? selected as Record<string, unknown>
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstInteger(value: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(value);
  return match ? Number(match[1]) : undefined;
}

function lastInteger(value: string, pattern: RegExp): number | undefined {
  const matches = [...value.matchAll(pattern)];
  return matches.length ? Number(matches.at(-1)?.[1]) : undefined;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
