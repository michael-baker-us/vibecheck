export type VerificationDefinition = {
  name: string;
  command: string;
  invalidatedBy: string[];
};

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
