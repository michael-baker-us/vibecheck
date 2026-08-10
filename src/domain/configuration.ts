export type VerificationDefinition = {
  name: string;
  command: string;
  invalidatedBy: string[];
  category?: VerificationCategory;
  required: boolean;
  /** Pins the metrics parser. Defaults to trying every adapter for the gate's category. */
  format?: VerificationFormat;
  /**
   * Repository-relative path to a machine-readable report the command writes. When present it is
   * parsed instead of the command's own output, which is far more robust than reading a terminal
   * stream carrying colour codes, progress redraws, and interleaved stderr.
   */
  reportPath?: string;
};

/**
 * Interchange formats (`junit`, `lcov`, `cobertura`, `sarif`) are preferred: any runner that can
 * emit one is supported without a dedicated adapter. The native formats keep the common cases
 * working with no configuration at all.
 */
export type VerificationFormat =
  | "auto"
  | "none"
  | "tap"
  | "jest"
  | "vitest"
  | "mocha"
  | "junit"
  | "istanbul-text"
  | "istanbul-json"
  | "lcov"
  | "cobertura"
  | "coverage-total"
  | "go-coverage"
  | "npm-audit-json"
  | "npm-audit-text"
  | "sarif";

export const VERIFICATION_FORMATS: VerificationFormat[] = [
  "auto",
  "none",
  "tap",
  "jest",
  "vitest",
  "mocha",
  "junit",
  "istanbul-text",
  "istanbul-json",
  "lcov",
  "cobertura",
  "coverage-total",
  "go-coverage",
  "npm-audit-json",
  "npm-audit-text",
  "sarif",
];

export type VerificationCategory =
  | "tests"
  | "coverage"
  | "security"
  | "quality"
  | "build"
  | "other";

/**
 * A gate the repository cannot run yet because a dependency is missing.
 *
 * Recommendations are declarative and inert: they describe what would enable the gate, and nothing
 * is installed or configured until an explicit apply action. The proposing agent never supplies a
 * command to install with — only the packages — so VibeCheck builds the install itself.
 */
export type GateRecommendation = {
  /** Stable identifier for apply actions, derived from the category and gate name. */
  id: string;
  category: VerificationCategory;
  /** Why the gate cannot run today, shown to the user before they apply anything. */
  reason: string;
  /** Dependencies to add. Validated as package tokens, never as shell input. */
  packages: string[];
  /** Which package manager to install with. Detected from the repository when omitted. */
  manager?: string;
  /** The verification entry to add once the dependencies are present. */
  gate: VerificationDefinition;
};

export type BoundaryRule = {
  name: string;
  from: string;
  cannotImport: string[];
};

export type VibeCheckConfiguration = {
  verification: VerificationDefinition[];
  recommendations: GateRecommendation[];
  boundaries: BoundaryRule[];
  diffExpansionThreshold: number;
  plans: PlanConfiguration;
};

export type PlanConfiguration = {
  include: string[];
  active?: string;
};

export const DEFAULT_PLAN_PATTERNS = [
  "PLAN.md",
  "plan.md",
  "plans/**/*.md",
  "docs/**/*plan*.md",
  ".claude/plans/*.md",
];

export const DEFAULT_CONFIGURATION: VibeCheckConfiguration = {
  verification: [],
  recommendations: [],
  boundaries: [],
  diffExpansionThreshold: 15,
  plans: { include: DEFAULT_PLAN_PATTERNS },
};
