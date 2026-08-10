export type CodeReviewProvider = "codex" | "claude";
export type CodeReviewProfile = "balanced" | "deep";
export type CodeReviewSelection = {
  provider: CodeReviewProvider;
  profile: CodeReviewProfile;
  model: string;
  effort: "medium" | "high";
};
/** A comparison to review or summarize: the working tree, or a fixed pair of revisions. */
export type RevisionRange = {
  scope: "working-tree" | "commits";
  base: string;
  target: string;
  baseLabel: string;
  targetLabel: string;
};

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
  profile: CodeReviewProfile;
  model: string;
  effort: "medium" | "high";
  status: CodeReviewStatus;
  /** Absent for a working-tree review, which is the default. */
  range?: RevisionRange;
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
