import { VerificationCategory, VerificationFormat } from "../domain/configuration";
import {
  CoverageSummary,
  SecuritySummary,
  TestSummary,
  VerificationSummary,
} from "../domain/verification";

/**
 * A metrics parser for one report format.
 *
 * `parse` doubles as detection: it returns `undefined` when the output is not in this format, so
 * the registry can simply try each adapter for a category and keep the first confident match.
 * Adapters must be conservative — a wrong match is worse than no match, because it reports
 * numbers the user will trust.
 */
export type VerificationFormatAdapter = {
  id: VerificationFormat;
  category: VerificationCategory;
  label: string;
  parse(output: string, previous?: VerificationSummary): VerificationSummary | undefined;
};

// --- tests -------------------------------------------------------------------------------------

/** `node --test`, and anything else emitting TAP's summary block. */
const tap: VerificationFormatAdapter = {
  id: "tap",
  category: "tests",
  label: "TAP",
  parse(output) {
    const total = lastInteger(output, /^# tests\s+(\d+)\s*$/gm);
    const passed = lastInteger(output, /^# pass\s+(\d+)\s*$/gm);
    const failed = lastInteger(output, /^# fail\s+(\d+)\s*$/gm);
    const skipped = lastInteger(output, /^# skipped\s+(\d+)\s*$/gm) ?? 0;
    if (total === undefined || passed === undefined || failed === undefined) return undefined;
    return { kind: "tests", total, passed, failed, skipped };
  },
};

/** Jest and Jest-compatible reporters: `Tests:  1 failed, 2 passed, 3 total`. */
const jest: VerificationFormatAdapter = {
  id: "jest",
  category: "tests",
  label: "Jest",
  parse(output) {
    const line = [...output.matchAll(/^Tests:\s+(.+)$/gm)].at(-1)?.[1];
    if (!line) return undefined;
    const total = firstInteger(line, /(\d+)\s+total/);
    if (total === undefined) return undefined;
    return {
      kind: "tests",
      total,
      passed: firstInteger(line, /(\d+)\s+passed/) ?? 0,
      failed: firstInteger(line, /(\d+)\s+failed/) ?? 0,
      skipped: firstInteger(line, /(\d+)\s+(?:skipped|pending|todo)/) ?? 0,
    };
  },
};

/**
 * Vitest: `      Tests  2 failed | 328 passed (330)`.
 *
 * Indented, pipe-separated, and — unlike Jest — with no colon after `Tests`, which is why the
 * Jest adapter never matched it.
 */
const vitest: VerificationFormatAdapter = {
  id: "vitest",
  category: "tests",
  label: "Vitest",
  parse(output) {
    const line = [...output.matchAll(/^\s*Tests\s{2,}(.+)$/gm)].at(-1)?.[1];
    if (!line) return undefined;
    const passed = firstInteger(line, /(\d+)\s+passed/) ?? 0;
    const failed = firstInteger(line, /(\d+)\s+failed/) ?? 0;
    const skipped = (firstInteger(line, /(\d+)\s+skipped/) ?? 0) + (firstInteger(line, /(\d+)\s+todo/) ?? 0);
    const total = firstInteger(line, /\((\d+)\)/) ?? passed + failed + skipped;
    if (!total && !passed && !failed) return undefined;
    return { kind: "tests", total, passed, failed, skipped };
  },
};

/** Mocha's spec reporter: `330 passing (8s)`, `2 failing`, `1 pending`. */
const mocha: VerificationFormatAdapter = {
  id: "mocha",
  category: "tests",
  label: "Mocha",
  parse(output) {
    const passed = lastInteger(output, /^\s*(\d+)\s+passing\b/gm);
    if (passed === undefined) return undefined;
    const failed = lastInteger(output, /^\s*(\d+)\s+failing\b/gm) ?? 0;
    const skipped = lastInteger(output, /^\s*(\d+)\s+pending\b/gm) ?? 0;
    return { kind: "tests", total: passed + failed + skipped, passed, failed, skipped };
  },
};

/**
 * JUnit XML — the interchange format. Vitest, Jest, Mocha, pytest, go-junit-report, .NET and most
 * CI-capable runners can emit it, so this single adapter covers far more ground than any native
 * parser. Counts come from the `<testsuites>` root when present, otherwise from summing suites.
 */
const junit: VerificationFormatAdapter = {
  id: "junit",
  category: "tests",
  label: "JUnit XML",
  parse(output) {
    const root = /<testsuites\b[^>]*\btests\s*=\s*"(\d+)"/i.exec(output);
    const suites = [...output.matchAll(/<testsuite\b[^>]*>/gi)].map((match) => match[0]);
    if (!root && !suites.length) return undefined;

    const attribute = (source: string, name: string) =>
      firstInteger(source, new RegExp(`\\b${name}\\s*=\\s*"(\\d+)"`, "i")) ?? 0;

    const rootTag = root ? /<testsuites\b[^>]*>/i.exec(output)?.[0] : undefined;
    const source = rootTag && attribute(rootTag, "tests") > 0 ? [rootTag] : suites;
    if (!source.length) return undefined;

    const total = source.reduce((sum, tag) => sum + attribute(tag, "tests"), 0);
    const failed = source.reduce((sum, tag) => sum + attribute(tag, "failures") + attribute(tag, "errors"), 0);
    const skipped = source.reduce((sum, tag) => sum + attribute(tag, "skipped"), 0);
    if (!total) return undefined;
    return { kind: "tests", total, passed: Math.max(0, total - failed - skipped), failed, skipped };
  },
};

// --- coverage ----------------------------------------------------------------------------------

/** Istanbul/nyc/c8/vitest text table: `All files | 87.53 | 70.58 | 90.96 | 87.53 |`. */
const istanbulText: VerificationFormatAdapter = {
  id: "istanbul-text",
  category: "coverage",
  label: "Istanbul text table",
  parse(output, previous) {
    const row = [...output.matchAll(/^All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/gm)].at(-1);
    if (!row) return undefined;
    return coverage({
      statements: Number(row[1]),
      branches: Number(row[2]),
      functions: Number(row[3]),
      lines: Number(row[4]),
    }, previous);
  },
};

/** Istanbul `coverage-summary.json`, and any report with the same `total.<metric>.pct` shape. */
const istanbulJson: VerificationFormatAdapter = {
  id: "istanbul-json",
  category: "coverage",
  label: "Istanbul JSON summary",
  parse(output, previous) {
    const json = parseJsonObject(output);
    const lines = finiteNumber(record(record(json, "total"), "lines")?.pct);
    if (lines === undefined) return undefined;
    return coverage({
      lines,
      statements: metricPercentage(json, "statements"),
      branches: metricPercentage(json, "branches"),
      functions: metricPercentage(json, "functions"),
    }, previous);
  },
};

/** LCOV tracefile totals, the interchange format for most language ecosystems. */
const lcov: VerificationFormatAdapter = {
  id: "lcov",
  category: "coverage",
  label: "LCOV",
  parse(output, previous) {
    const sum = (prefix: string) =>
      [...output.matchAll(new RegExp(`^${prefix}:(\\d+)\\s*$`, "gm"))]
        .reduce((total, match) => total + Number(match[1]), 0);
    const ratio = (found: number, hit: number) => (found > 0 ? round((hit / found) * 100) : undefined);

    const linesFound = sum("LF");
    if (linesFound === 0) return undefined;
    const lines = ratio(linesFound, sum("LH"));
    if (lines === undefined) return undefined;
    return coverage({
      lines,
      statements: lines,
      branches: ratio(sum("BRF"), sum("BRH")),
      functions: ratio(sum("FNF"), sum("FNH")),
    }, previous);
  },
};

/** Cobertura XML, emitted by pytest-cov, coverlet, JaCoCo converters and many CI tools. */
const cobertura: VerificationFormatAdapter = {
  id: "cobertura",
  category: "coverage",
  label: "Cobertura XML",
  parse(output, previous) {
    const tag = /<coverage\b[^>]*>/i.exec(output)?.[0];
    if (!tag) return undefined;
    const rate = (name: string) => {
      const match = new RegExp(`\\b${name}\\s*=\\s*"([\\d.]+)"`, "i").exec(tag);
      return match ? round(Number(match[1]) * 100) : undefined;
    };
    const lines = rate("line-rate");
    if (lines === undefined) return undefined;
    return coverage({ lines, statements: lines, branches: rate("branch-rate") }, previous);
  },
};

/** `coverage: 87.5% of statements` from `go test -cover`. */
const goCoverage: VerificationFormatAdapter = {
  id: "go-coverage",
  category: "coverage",
  label: "Go coverage",
  parse(output, previous) {
    const value = [...output.matchAll(/coverage:\s*([\d.]+)%\s*of\s*statements/gi)].at(-1)?.[1];
    if (value === undefined) return undefined;
    return coverage({ lines: Number(value), statements: Number(value) }, previous);
  },
};

/** pytest-cov and similar `TOTAL … 95%` summary rows. Tried last: it is the loosest match. */
const coverageTotal: VerificationFormatAdapter = {
  id: "coverage-total",
  category: "coverage",
  label: "TOTAL row",
  parse(output, previous) {
    const value = [...output.matchAll(/^\s*TOTAL\b.*?([\d.]+)\s*%\s*$/gim)].at(-1)?.[1];
    if (value === undefined) return undefined;
    return coverage({ lines: Number(value), statements: Number(value) }, previous);
  },
};

// --- security ----------------------------------------------------------------------------------

/** `npm audit --json`. */
const npmAuditJson: VerificationFormatAdapter = {
  id: "npm-audit-json",
  category: "security",
  label: "npm audit JSON",
  parse(output, previous) {
    const json = parseJsonObject(output);
    const metadataCounts = record(record(json, "metadata"), "vulnerabilities");
    if (!metadataCounts) return undefined;
    const counts = securityCounts(metadataCounts);
    const vulnerabilities = record(json, "vulnerabilities");
    const issueIds = vulnerabilities ? Object.keys(vulnerabilities).sort() : undefined;
    return {
      kind: "security",
      ...counts,
      ...securityChanges(counts.total, issueIds, previous),
      ...(issueIds ? { issueIds } : {}),
    };
  },
};

/** `npm audit` human output, including the `found 0 vulnerabilities` case. */
const npmAuditText: VerificationFormatAdapter = {
  id: "npm-audit-text",
  category: "security",
  label: "npm audit text",
  parse(output, previous) {
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
  },
};

/**
 * SARIF — the interchange format for static analysis and dependency scanners (semgrep, CodeQL,
 * trivy, grype, osv-scanner). Severity comes from `security-severity` when present, since SARIF
 * levels alone collapse everything into error/warning/note.
 */
const sarif: VerificationFormatAdapter = {
  id: "sarif",
  category: "security",
  label: "SARIF",
  parse(output, previous) {
    const json = parseJsonObject(output);
    if (!json || typeof json.version !== "string" || !Array.isArray(json.runs)) return undefined;

    const counts = { total: 0, critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
    const issueIds: string[] = [];
    for (const run of json.runs) {
      const results = record(run)?.results;
      if (!Array.isArray(results)) continue;
      for (const entry of results) {
        const result = record(entry);
        if (!result) continue;
        counts.total += 1;
        counts[sarifSeverity(result)] += 1;
        const ruleId = typeof result.ruleId === "string" ? result.ruleId : undefined;
        if (ruleId) issueIds.push(ruleId);
      }
    }
    if (!Array.isArray(json.runs) || (!counts.total && !json.runs.length)) return undefined;

    const unique = [...new Set(issueIds)].sort();
    return {
      kind: "security",
      ...counts,
      ...securityChanges(counts.total, unique.length ? unique : undefined, previous),
      ...(unique.length ? { issueIds: unique } : {}),
    };
  },
};

function sarifSeverity(result: Record<string, unknown>): "critical" | "high" | "moderate" | "low" | "info" {
  const score = Number(record(result, "properties")?.["security-severity"]);
  if (Number.isFinite(score)) {
    if (score >= 9) return "critical";
    if (score >= 7) return "high";
    if (score >= 4) return "moderate";
    return "low";
  }
  const level = typeof result.level === "string" ? result.level : "warning";
  if (level === "error") return "high";
  if (level === "warning") return "moderate";
  if (level === "note") return "low";
  return "info";
}

/**
 * Registry order is match precedence. Structured formats come first because they are
 * unambiguous, and the loosest text matchers come last.
 */
export const VERIFICATION_FORMAT_ADAPTERS: VerificationFormatAdapter[] = [
  junit, tap, jest, vitest, mocha,
  istanbulJson, cobertura, lcov, istanbulText, goCoverage, coverageTotal,
  npmAuditJson, sarif, npmAuditText,
];

export function adapterFor(id: VerificationFormat): VerificationFormatAdapter | undefined {
  return VERIFICATION_FORMAT_ADAPTERS.find((adapter) => adapter.id === id);
}

export function adaptersForCategory(category: VerificationCategory): VerificationFormatAdapter[] {
  return VERIFICATION_FORMAT_ADAPTERS.filter((adapter) => adapter.category === category);
}

// --- shared helpers ----------------------------------------------------------------------------

function coverage(
  values: { lines: number; statements?: number; branches?: number; functions?: number },
  previous?: VerificationSummary,
): CoverageSummary | undefined {
  if (!Number.isFinite(values.lines)) return undefined;
  const prior = previous?.kind === "coverage" ? previous.lines : undefined;
  return {
    kind: "coverage",
    ...values,
    ...(prior === undefined ? {} : { change: round(values.lines - prior) }),
  };
}

function securityCounts(value: Record<string, unknown>): Omit<SecuritySummary, "kind" | "newIssues" | "fixedIssues" | "issueIds"> {
  const critical = finiteNumber(value.critical) ?? 0;
  const high = finiteNumber(value.high) ?? 0;
  const moderate = finiteNumber(value.moderate) ?? 0;
  const low = finiteNumber(value.low) ?? 0;
  const info = finiteNumber(value.info) ?? 0;
  return { total: finiteNumber(value.total) ?? critical + high + moderate + low + info, critical, high, moderate, low, info };
}

function securityChanges(
  total: number,
  issueIds: string[] | undefined,
  previous?: VerificationSummary,
): Pick<SecuritySummary, "newIssues" | "fixedIssues"> {
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

export type { TestSummary };
