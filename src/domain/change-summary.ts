import { CodeReviewSelection, RevisionRange } from "./code-review";
import { CodeReviewTranscriptEntry } from "./code-review";

export type ChangeSummaryRange = RevisionRange;

export type ChangeSummaryRequest = ChangeSummaryRange & CodeReviewSelection;

export type ChangeSummaryHighlight = {
  heading: string;
  description: string;
};

export type ChangeSummaryResult = {
  title: string;
  overview: string;
  highlights: ChangeSummaryHighlight[];
  impact?: string;
  validation?: string;
};

export type ChangeSummarySession = ChangeSummaryRequest & {
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  transcript: CodeReviewTranscriptEntry[];
  error?: string;
};
