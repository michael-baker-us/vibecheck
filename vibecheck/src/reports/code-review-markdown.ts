import { CodeReviewState } from "../domain/code-review";

export type CodeReviewReportContext = {
  branch?: string;
};

export function buildCodeReviewMarkdown(
  review: CodeReviewState,
  context: CodeReviewReportContext = {},
): string {
  return [
    "# VibeCheck Code Review",
    "",
    `- Provider: ${review.provider}`,
    `- Profile: ${review.profile}`,
    `- Model: \`${review.model}\``,
    `- Effort: ${review.effort}`,
    `- Status: ${review.status}`,
    `- Baseline: \`${review.baselineCommit}\``,
    ...(context.branch ? [`- Branch: ${context.branch}`] : []),
    `- Started: ${review.startedAt}`,
    ...(review.finishedAt ? [`- Finished: ${review.finishedAt}`] : []),
    "",
    ...codeReviewBody(review, 2, 3),
    "",
  ].join("\n");
}

export function buildCodeReviewSection(review: CodeReviewState): string {
  return [
    "## Code review",
    "",
    `- Provider: ${review.provider}`,
    `- Profile: ${review.profile}`,
    `- Model: \`${review.model}\``,
    `- Effort: ${review.effort}`,
    `- Status: ${review.status}`,
    `- Baseline: \`${review.baselineCommit}\``,
    "",
    ...codeReviewBody(review, 3, 4),
    "",
  ].join("\n");
}

function codeReviewBody(
  review: CodeReviewState,
  sectionHeadingLevel: number,
  findingHeadingLevel: number,
): string[] {
  const sectionHeading = "#".repeat(sectionHeadingLevel);
  const lines = [
    `${sectionHeading} Summary`,
    "",
    review.summary ?? statusSummary(review),
    "",
    `${sectionHeading} Findings`,
    "",
  ];
  if (!review.findings.length) {
    lines.push(review.status === "completed" ? "No actionable defects reported." : "No findings available.");
    return lines;
  }
  const heading = "#".repeat(findingHeadingLevel);
  review.findings.forEach((finding, index) => {
    lines.push(`${heading} ${index + 1}. ${finding.severity.toUpperCase()} — ${finding.title}`, "");
    if (finding.path) {
      const range = finding.line
        ? `:${finding.line}${finding.endLine && finding.endLine !== finding.line ? `-${finding.endLine}` : ""}`
        : "";
      lines.push(`**Location:** \`${finding.path}${range}\``, "");
    }
    lines.push(finding.explanation, "");
  });
  return lines;
}

function statusSummary(review: CodeReviewState): string {
  if (review.status === "running") return "Review is still running.";
  if (review.status === "stale") return "The working-tree diff changed after this review completed.";
  if (review.status === "failed") return review.error ?? "The review provider failed.";
  return "Review completed.";
}
