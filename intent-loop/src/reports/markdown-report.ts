import { ObservationState } from "../domain/observation-state";
import { currentPlanTask, planProgress } from "../domain/plans";

export function buildMarkdownReport(state: ObservationState): string {
  const lines = [
    "# Intent Loop Review",
    "",
    `- Baseline: \`${state.baselineCommit}\``,
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

  lines.push("## Verification", "");
  if (state.verification.length === 0) {
    lines.push("No verification commands configured.");
  } else {
    lines.push("| Check | Status | Command |", "| --- | --- | --- |");
    for (const item of state.verification) {
      lines.push(`| ${item.name} | ${item.status} | \`${item.command.replaceAll("|", "\\|")}\` |`);
    }
  }

  lines.push("", "## Changed files", "");
  for (const file of state.changedFiles) {
    lines.push(`- ${file.status}: \`${file.path}\`${file.binary ? " (binary)" : ""}`);
  }
  lines.push("");
  return lines.join("\n");
}
