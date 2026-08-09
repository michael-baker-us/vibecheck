import { VerificationCategory } from "./configuration";

export type VerificationStatus = "not-run" | "running" | "passed" | "failed" | "stale";

export type TestSummary = {
  kind: "tests";
  total: number;
  passed: number;
  failed: number;
  skipped: number;
};

export type CoverageSummary = {
  kind: "coverage";
  lines: number;
  statements?: number;
  branches?: number;
  functions?: number;
  change?: number;
};

export type SecuritySummary = {
  kind: "security";
  total: number;
  critical: number;
  high: number;
  moderate: number;
  low: number;
  info: number;
  newIssues: number;
  fixedIssues: number;
  issueIds?: string[];
};

export type VerificationSummary = TestSummary | CoverageSummary | SecuritySummary;

export type VerificationState = {
  name: string;
  command: string;
  invalidatedBy: string[];
  category?: VerificationCategory;
  required: boolean;
  status: VerificationStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number;
  output?: string;
  inputHashes?: Record<string, string>;
  summary?: VerificationSummary;
};
