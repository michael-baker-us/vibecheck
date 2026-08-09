export type FindingSeverity = "info" | "medium" | "high";
export type FindingBasis = "fact" | "configured-rule" | "heuristic";
export type FindingStatus = "open" | "accepted" | "dismissed" | "resolved";

export type EvidenceReference = {
  path?: string;
  line?: number;
  detail: string;
};

export type Finding = {
  id: string;
  fingerprint: string;
  ruleId: string;
  title: string;
  explanation: string;
  severity: FindingSeverity;
  basis: FindingBasis;
  evidence: EvidenceReference[];
  status: FindingStatus;
  firstObservedAt: string;
  lastObservedAt: string;
};

export type FindingCandidate = Omit<
  Finding,
  "id" | "fingerprint" | "status" | "firstObservedAt" | "lastObservedAt"
> & {
  fingerprintParts: string[];
};
