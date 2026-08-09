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

export type BoundaryRule = {
  name: string;
  from: string;
  cannotImport: string[];
};

export type VibeCheckConfiguration = {
  verification: VerificationDefinition[];
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
  boundaries: [],
  diffExpansionThreshold: 15,
  plans: { include: DEFAULT_PLAN_PATTERNS },
};
