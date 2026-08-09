import { ObservationState } from "../domain/observation-state";
import { currentPlanTask } from "../domain/plans";

export function buildFollowUpPrompt(state: ObservationState, findingIds?: string[]): string {
  const selected = state.findings.filter(
    (finding) =>
      finding.status === "open" && (!findingIds || findingIds.includes(finding.id)),
  );
  const verification = state.verification.filter((item) =>
    ["failed", "stale", "not-run"].includes(item.status),
  );

  const lines: string[] = [];
  if (state.activePlan) {
    const current = currentPlanTask(state.activePlan);
    lines.push(`Stay aligned with the repository plan at ${state.activePlan.path}: ${state.activePlan.title}.`);
    if (current) lines.push(`Current incomplete plan step: ${current.text}`);
    if (state.activePlan.excerpt) lines.push(`Plan context: ${state.activePlan.excerpt}`);
    lines.push("");
  }
  if (selected.length > 0) {
    lines.push("Review these observed findings:");
    for (const finding of selected) {
      const location = finding.evidence.find((evidence) => evidence.path);
      lines.push(
        `- ${finding.title}${location?.path ? ` (${location.path}${location.line ? `:${location.line}` : ""})` : ""}: ${finding.explanation}`,
      );
    }
    lines.push("");
  }
  if (verification.length > 0) {
    lines.push("Verification still needs attention:");
    for (const item of verification) {
      lines.push(`- ${item.name}: ${item.status} (${item.command})`);
    }
    lines.push("");
  }
  lines.push(
    "Inspect the evidence, explain any intentional tradeoffs, make the smallest appropriate corrections, and rerun the relevant verification after the final code change. Do not claim a finding is resolved without current evidence.",
  );
  return lines.join("\n");
}
