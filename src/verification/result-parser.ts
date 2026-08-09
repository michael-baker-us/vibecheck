import { VerificationCategory, VerificationFormat } from "../domain/configuration";
import { VerificationSummary } from "../domain/verification";

import { adapterFor, adaptersForCategory } from "./formats";

export type ParsedVerificationSummary = {
  summary?: VerificationSummary;
  /** Which adapter produced the summary, for display and for debugging a misparse. */
  format?: VerificationFormat;
  /**
   * True when the gate's category should produce metrics but no adapter recognised the output.
   * The UI uses this to say so explicitly rather than rendering an empty tile that looks
   * identical to a gate that never ran.
   */
  unrecognized: boolean;
};

const MEASURABLE: VerificationCategory[] = ["tests", "coverage", "security"];

/**
 * Resolves a gate's output to structured metrics.
 *
 * With no configured format every adapter for the category is tried in registry order and the
 * first confident match wins. A configured format pins one adapter, which is the escape hatch
 * for output that two adapters could both plausibly claim.
 */
export function parseVerificationResult(
  category: VerificationCategory,
  output: string,
  previous?: VerificationSummary,
  format?: VerificationFormat,
): ParsedVerificationSummary {
  if (format === "none") return { unrecognized: false };

  const candidates = format && format !== "auto"
    ? [adapterFor(format)].filter((adapter) => adapter !== undefined)
    : adaptersForCategory(category);

  for (const adapter of candidates) {
    const summary = adapter.parse(output, previous);
    if (summary) return { summary, format: adapter.id, unrecognized: false };
  }

  return { unrecognized: MEASURABLE.includes(category) };
}

/** Back-compatible helper for callers that only need the summary. */
export function parseVerificationSummary(
  category: VerificationCategory,
  output: string,
  previous?: VerificationSummary,
  format?: VerificationFormat,
): VerificationSummary | undefined {
  return parseVerificationResult(category, output, previous, format).summary;
}
