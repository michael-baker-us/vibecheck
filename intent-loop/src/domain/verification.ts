export type VerificationStatus = "not-run" | "running" | "passed" | "failed" | "stale";

export type VerificationState = {
  name: string;
  command: string;
  invalidatedBy: string[];
  status: VerificationStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number;
  output?: string;
  inputHashes?: Record<string, string>;
};
