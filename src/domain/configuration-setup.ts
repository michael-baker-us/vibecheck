import { CodeReviewSelection, CodeReviewTranscriptEntry } from "./code-review";

export type ConfigurationSetupSession = CodeReviewSelection & {
  mode: "setup" | "update";
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  transcript: CodeReviewTranscriptEntry[];
  changedFiles: string[];
  error?: string;
};

export type ConfigurationSetupResult = {
  changedFiles: string[];
};
