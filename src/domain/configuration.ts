export type VerificationDefinition = {
  name: string;
  command: string;
  invalidatedBy: string[];
  category?: VerificationCategory;
  required: boolean;
};

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
