import { CodeReviewSelection, CodeReviewTranscriptEntry } from "./code-review";

export type ReadmeMaintenanceMode = "full" | "incremental";

export type ReadmeMaintenanceRequest = CodeReviewSelection & {
  headCommit: string;
  mode: ReadmeMaintenanceMode;
  baseCommit?: string;
};

export type ReadmeMaintenanceResult = {
  summary: string;
  content: string;
};

export type ReadmeMaintenanceSession = CodeReviewSelection & {
  headCommit: string;
  mode?: ReadmeMaintenanceMode;
  baseCommit?: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  transcript: CodeReviewTranscriptEntry[];
  summary?: string;
  error?: string;
};
