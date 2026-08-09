import { ObservationState } from "../domain/observation-state";
import { currentPlanTask, planProgress } from "../domain/plans";
import { VerificationState, VerificationSummary } from "../domain/verification";
import { buildCodeReviewSection } from "./code-review-markdown";

export function buildMarkdownReport(state: ObservationState): string {
  const lines = [
    "# VibeCheck Evidence Report",
    "",
    `- Current commit: \`${state.baselineCommit}\``,
    `- Branch: ${state.headBranch ?? "detached HEAD"}`,
    ...(state.headSubject ? [`- Commit subject: ${state.headSubject}`] : []),
    `- Started: ${state.startedAt}`,
    `- Updated: ${state.lastUpdatedAt}`,
    `- Changed files: ${state.changedFiles.length}`,
  ];
  if (state.activePlan) {
    lines.push(`- Active plan: \`${state.activePlan.path}\` — ${state.activePlan.title}`);
    const progress = planProgress(state.activePlan);
    if (progress) lines.push(`- Plan progress: ${progress}`);
    const current = currentPlanTask(state.activePlan);
    if (current) lines.push(`- Current plan step: ${current.text}`);
  }

  lines.push("", "## Attention", "");
  const open = state.findings.filter((finding) => finding.status === "open");
  if (open.length === 0) {
    lines.push("No open findings.");
  } else {
    for (const finding of open) {
      lines.push(`### ${finding.severity.toUpperCase()}: ${finding.title}`, "", finding.explanation, "");
      lines.push(`Basis: ${finding.basis}`, "", "Evidence:");
      for (const evidence of finding.evidence) {
        lines.push(
          `- ${evidence.path ? `\`${evidence.path}${evidence.line ? `:${evidence.line}` : ""}\`: ` : ""}${evidence.detail}`,
        );
      }
      lines.push("");
    }
  }

  if (!state.codeReview) {
    lines.push("## Code review", "", "No semantic code review has been run.", "");
  } else {
    lines.push(buildCodeReviewSection(state.codeReview));
  }

  lines.push("## Quality gates", "");
  if (state.verification.length === 0) {
    lines.push("No verification commands configured.");
  } else {
    lines.push(
      "| Check | Status | Result | Last run | Duration |",
      "| --- | --- | --- | --- | ---: |",
    );
    for (const item of state.verification) {
      lines.push(`| ${escapeCell(item.name)} | ${item.status} | ${escapeCell(summaryText(item.summary))} | ${item.finishedAt ?? "—"} | ${durationText(item.durationMs)} |`);
    }
    lines.push("", "### Commands", "");
    for (const item of state.verification) {
      lines.push(`- **${item.name}:** \`${item.command.replaceAll("|", "\\|")}\``);
    }
  }

  lines.push("", "## Changed files", "");
  for (const file of state.changedFiles) {
    lines.push(`- ${file.status}: \`${file.path}\`${file.binary ? " (binary)" : ""}`);
  }
  lines.push("");
  return lines.join("\n");
}

function summaryText(summary: VerificationSummary | undefined): string {
  if (!summary) return "No structured metrics";
  if (summary.kind === "tests") {
    return `${summary.passed}/${summary.total} passed, ${summary.failed} failed${summary.skipped ? `, ${summary.skipped} skipped` : ""}`;
  }
  if (summary.kind === "coverage") {
    const detail = [
      `lines ${percentage(summary.lines)}`,
      summary.branches === undefined ? undefined : `branches ${percentage(summary.branches)}`,
      summary.functions === undefined ? undefined : `functions ${percentage(summary.functions)}`,
      summary.statements === undefined ? undefined : `statements ${percentage(summary.statements)}`,
    ].filter(Boolean).join(", ");
    return `${detail}${trendText(summary.change)}`;
  }
  const severity = [
    summary.critical ? `${summary.critical} critical` : undefined,
    summary.high ? `${summary.high} high` : undefined,
    summary.moderate ? `${summary.moderate} moderate` : undefined,
    summary.low ? `${summary.low} low` : undefined,
  ].filter(Boolean).join(", ");
  const changes = [
    summary.newIssues ? `${summary.newIssues} new` : undefined,
    summary.fixedIssues ? `${summary.fixedIssues} fixed` : undefined,
  ].filter(Boolean).join(", ");
  return `${summary.total} vulnerabilities${severity ? ` (${severity})` : ""}${changes ? `; ${changes}` : ""}`;
}

function trendText(change: number | undefined): string {
  if (change === undefined || change === 0) return "";
  return ` (${change > 0 ? "+" : ""}${change.toFixed(2)} pp)`;
}

function percentage(value: number): string {
  return `${value.toFixed(2)}%`;
}

function durationText(durationMs: VerificationState["durationMs"]): string {
  if (durationMs === undefined) return "—";
  return durationMs < 1_000 ? `${durationMs} ms` : `${(durationMs / 1_000).toFixed(1)} s`;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
