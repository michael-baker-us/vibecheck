import { ChangeSummaryRange, ChangeSummaryResult } from "../domain/change-summary";
import { CodeReviewSelection } from "../domain/code-review";

export function buildChangeSummaryMarkdown(
  summary: ChangeSummaryResult,
  range: ChangeSummaryRange,
  selection: CodeReviewSelection,
): string {
  const lines = [
    `# ${summary.title}`,
    "",
    `> Changes from \`${range.baseLabel}\` to \`${range.targetLabel}\``,
    `> Created by ${providerName(selection.provider)} using \`${selection.model}\` (${selection.profile}, ${selection.effort} effort)`,
    "",
    "## Overview",
    "",
    summary.overview,
    "",
    "## What changed",
    "",
    ...summary.highlights.map(({ heading, description }) => `- **${heading}:** ${description}`),
  ];

  if (summary.impact) lines.push("", "## Impact", "", summary.impact);
  if (summary.validation) lines.push("", "## Validation", "", summary.validation);
  lines.push("");
  return lines.join("\n");
}

function providerName(provider: CodeReviewSelection["provider"]): string {
  return provider === "codex" ? "Codex" : "Claude";
}
