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

export type IntentLoopConfiguration = {
  verification: VerificationDefinition[];
  boundaries: BoundaryRule[];
  diffExpansionThreshold: number;
};

export const DEFAULT_CONFIGURATION: IntentLoopConfiguration = {
  verification: [],
  boundaries: [],
  diffExpansionThreshold: 15,
};
