import { VerificationDefinition, VerificationCategory } from "./configuration";
import { Finding } from "./findings";
import { VerificationState } from "./verification";

export const RECOMMENDED_GATE_CATEGORIES: VerificationCategory[] = [
  "tests",
  "coverage",
  "security",
];

export type Readiness = {
  status: "ready" | "blocked" | "incomplete";
  label: string;
  reasons: string[];
};

export function categoryFor(definition: Pick<VerificationDefinition, "name" | "command" | "category">): VerificationCategory {
  if (definition.category) return definition.category;
  const value = `${definition.name} ${definition.command}`.toLowerCase();
  if (/cover(age)?|c8|nyc/.test(value)) return "coverage";
  if (/audit|secur|snyk|semgrep|trivy|dependency.check/.test(value)) return "security";
  if (/test|spec|vitest|jest|mocha|pytest/.test(value)) return "tests";
  if (/lint|typecheck|type.check|eslint|ruff/.test(value)) return "quality";
  if (/build|compile/.test(value)) return "build";
  return "other";
}

export function missingRecommendedCategories(definitions: VerificationDefinition[]): VerificationCategory[] {
  const configured = new Set(definitions.map(categoryFor));
  return RECOMMENDED_GATE_CATEGORIES.filter((category) => !configured.has(category));
}

export function calculateReadiness(
  findings: Finding[],
  verification: VerificationState[],
): Readiness {
  const reasons: string[] = [];
  const blockingFindings = findings.filter(
    (finding) => finding.status === "open" && finding.severity === "high",
  );
  if (blockingFindings.length) reasons.push(`${blockingFindings.length} high-risk finding${blockingFindings.length === 1 ? "" : "s"} unresolved`);

  const required = verification.filter((check) => check.required !== false);
  const failed = required.filter((check) => check.status === "failed");
  const stale = required.filter((check) => check.status === "stale");
  const pending = required.filter((check) => check.status === "not-run" || check.status === "running");
  if (failed.length) reasons.push(`${failed.length} required check${failed.length === 1 ? "" : "s"} failed`);
  if (stale.length) reasons.push(`${stale.length} required check${stale.length === 1 ? "" : "s"} stale`);
  if (pending.length) reasons.push(`${pending.length} required check${pending.length === 1 ? "" : "s"} not complete`);
  if (!required.length) reasons.push("No required quality gates configured");

  if (blockingFindings.length || failed.length) return { status: "blocked", label: "Action needed", reasons };
  if (reasons.length) return { status: "incomplete", label: "Checks needed", reasons };
  return { status: "ready", label: "Checks current", reasons: [] };
}

export type VerificationBadge = { value: number; tooltip: string };

/**
 * Notification badge for the VibeCheck view. This is deliberately narrower than readiness:
 * findings, failures, setup recommendations, and checks in progress remain visible in the
 * Control Center without turning the activity-bar icon into a persistent notification.
 */
export function staleVerificationBadge(verification: VerificationState[]): VerificationBadge | undefined {
  const stale = verification.filter((check) => check.required !== false && check.status === "stale");
  if (!stale.length) return undefined;
  return {
    value: 1,
    tooltip: `VibeCheck: ${stale.length} required check${stale.length === 1 ? "" : "s"} stale`,
  };
}
