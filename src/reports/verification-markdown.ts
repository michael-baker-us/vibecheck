import { categoryFor } from "../domain/quality-gates";
import { VerificationState, VerificationSummary } from "../domain/verification";

export function buildVerificationReport(state: VerificationState): string {
  const category = categoryFor(state);
  const lines = [
    `# Quality Gate Report: ${singleLine(state.name)}`,
    "",
    `> ${statusLabel(state.status)} — ${verificationOutcomeText(state)}`,
    "",
    "## Result",
    "",
    verificationSummaryText(state.summary),
  ];

  if (state.summary) lines.push("", ...summaryDetails(state.summary));

  const highlights = state.status === "failed" ? diagnosticHighlights(state.output) : [];
  if (highlights.length) {
    lines.push("", "## Diagnostic highlights", "");
    for (const highlight of highlights) lines.push(`- ${escapeMarkdown(highlight)}`);
  }

  lines.push(
    "",
    "## Run details",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Category | ${category} |`,
    `| Policy | ${state.required === false ? "Advisory" : "Required"} |`,
    `| Status | ${statusLabel(state.status)} |`,
    `| Exit code | ${state.exitCode ?? "—"} |`,
    `| Started | ${state.startedAt ?? "—"} |`,
    `| Finished | ${state.finishedAt ?? "—"} |`,
    `| Duration | ${verificationDurationText(state.durationMs)} |`,
    `| Invalidated by | ${state.invalidatedBy.length ? state.invalidatedBy.map((pattern) => `\`${escapeInlineCode(pattern)}\``).join(", ") : "No configured paths"} |`,
    "",
    "### Command",
    "",
    fencedBlock(state.command, "shell"),
    "",
    "## Raw command output",
    "",
    state.output?.trim() ? fencedBlock(cleanOutput(state.output), "text") : "No command output was recorded.",
    "",
  );
  return lines.join("\n");
}

export function verificationSummaryText(summary: VerificationSummary | undefined): string {
  if (!summary) return "No structured metrics were detected. The command status and raw output remain available below.";
  if (summary.kind === "tests") {
    const failures = summary.failed === 0 ? "No tests failed." : `${summary.failed} ${plural(summary.failed, "test")} failed.`;
    const skipped = summary.skipped ? ` ${summary.skipped} ${plural(summary.skipped, "test")} skipped.` : "";
    return `${summary.passed} of ${summary.total} tests passed (${percentage(ratio(summary.passed, summary.total))}). ${failures}${skipped}`;
  }
  if (summary.kind === "coverage") {
    const trend = summary.change === undefined || summary.change === 0
      ? ""
      : ` This is ${Math.abs(summary.change).toFixed(2)} percentage points ${summary.change > 0 ? "higher" : "lower"} than the previous run.`;
    return `Line coverage is ${percentage(summary.lines)}.${trend}`;
  }
  if (summary.total === 0) {
    const fixed = summary.fixedIssues ? ` ${summary.fixedIssues} ${plural(summary.fixedIssues, "vulnerability")} fixed since the previous run.` : "";
    return `No known vulnerabilities were reported.${fixed}`;
  }
  const severe = summary.critical + summary.high;
  const movement = [
    summary.newIssues ? `${summary.newIssues} new` : undefined,
    summary.fixedIssues ? `${summary.fixedIssues} fixed` : undefined,
  ].filter(Boolean).join(" and ");
  return `${summary.total} known ${plural(summary.total, "vulnerability")} reported; ${severe} high or critical.${movement ? ` Since the previous run: ${movement}.` : ""}`;
}

export function verificationOutcomeText(state: VerificationState): string {
  if (state.status === "passed") return "The command completed successfully and its evidence is current.";
  if (state.status === "failed") return `The command failed${state.exitCode === undefined ? "" : ` with exit code ${state.exitCode}`}. Review the diagnostic highlights and raw output.`;
  if (state.status === "stale") return "This result no longer reflects the current repository inputs. Run the gate again.";
  if (state.status === "running") return "The command is still running. Results will update when it finishes.";
  return "This gate has not been run yet.";
}

export function verificationDurationText(durationMs: number | undefined): string {
  if (durationMs === undefined) return "—";
  if (durationMs < 1_000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function summaryDetails(summary: VerificationSummary): string[] {
  if (summary.kind === "tests") {
    return [
      "| Tests | Count |",
      "| --- | ---: |",
      `| Passed | ${summary.passed} |`,
      `| Failed | ${summary.failed} |`,
      `| Skipped | ${summary.skipped} |`,
      `| Total | ${summary.total} |`,
    ];
  }
  if (summary.kind === "coverage") {
    return [
      "| Coverage | Result |",
      "| --- | ---: |",
      `| Lines | ${percentage(summary.lines)} |`,
      `| Branches | ${summary.branches === undefined ? "—" : percentage(summary.branches)} |`,
      `| Functions | ${summary.functions === undefined ? "—" : percentage(summary.functions)} |`,
      `| Statements | ${summary.statements === undefined ? "—" : percentage(summary.statements)} |`,
      `| Change from previous run | ${summary.change === undefined ? "—" : `${summary.change > 0 ? "+" : ""}${summary.change.toFixed(2)} pp`} |`,
    ];
  }
  const lines = [
    "| Severity | Vulnerabilities |",
    "| --- | ---: |",
    `| Critical | ${summary.critical} |`,
    `| High | ${summary.high} |`,
    `| Moderate | ${summary.moderate} |`,
    `| Low | ${summary.low} |`,
    `| Informational | ${summary.info} |`,
    `| Total | ${summary.total} |`,
  ];
  if (summary.issueIds?.length) {
    lines.push("", "Affected packages or issue identifiers:", "", ...summary.issueIds.map((id) => `- \`${escapeInlineCode(id)}\``));
  }
  return lines;
}

function diagnosticHighlights(output: string | undefined): string[] {
  if (!output) return [];
  const selected: string[] = [];
  for (const line of cleanOutput(output).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !/(?:\berror\b|\bfailed\b|\bfailure\b|\bfatal\b|\bwarn(?:ing)?\b|[✖×])/i.test(trimmed)) continue;
    const concise = trimmed.length > 240 ? `${trimmed.slice(0, 237)}…` : trimmed;
    if (!selected.includes(concise)) selected.push(concise);
  }
  return selected.slice(-8);
}

function cleanOutput(output: string): string {
  return output
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function fencedBlock(value: string, language: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

function statusLabel(status: VerificationState["status"]): string {
  return ({ "not-run": "Not run", running: "Running", passed: "Passed", failed: "Failed", stale: "Stale" })[status];
}

function percentage(value: number): string {
  return `${value.toFixed(2)}%`;
}

function ratio(value: number, total: number): number {
  return total === 0 ? 0 : (value / total) * 100;
}

function plural(count: number, singular: string): string {
  if (count === 1) return singular;
  return /[^aeiou]y$/i.test(singular) ? `${singular.slice(0, -1)}ies` : `${singular}s`;
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]<>])/g, "\\$1");
}

function escapeInlineCode(value: string): string {
  return value.replaceAll("`", "\\`").replaceAll("|", "\\|");
}
