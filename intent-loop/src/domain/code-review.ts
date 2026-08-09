export type CodeReviewProvider = "codex" | "claude";
export type CodeReviewStatus = "running" | "completed" | "failed" | "stale";
export type CodeReviewSeverity = "info" | "medium" | "high";

export type CodeReviewFinding = {
  id: string;
  title: string;
  explanation: string;
  severity: CodeReviewSeverity;
  path?: string;
  line?: number;
  endLine?: number;
};

export type CodeReviewActivity = {
  at: string;
  label: string;
  detail?: string;
};

export type CodeReviewTranscriptEntry = {
  at: string;
  kind: "assistant" | "tool" | "output" | "status" | "error";
  label: string;
  content?: string;
};

export type CodeReviewState = {
  provider: CodeReviewProvider;
  status: CodeReviewStatus;
  baselineCommit: string;
  changeFingerprint: string;
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  findings: CodeReviewFinding[];
  activity: CodeReviewActivity[];
  error?: string;
};

export type CodeReviewResult = Pick<CodeReviewState, "summary" | "findings">;
