import { ObservationState } from "../domain/observation-state";

export function buildFollowUpPrompt(state: ObservationState, findingIds?: string[]): string {
  const selected = state.findings.filter(
    (finding) =>
      finding.status === "open" && (!findingIds || findingIds.includes(finding.id)),
  );
  const verification = state.verification.filter((item) =>
    ["failed", "stale", "not-run"].includes(item.status),
  );

  const lines: string[] = [];
  if (state.workingIntent) {
    lines.push(`Continue working toward this intent: ${state.workingIntent}`, "");
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
