import { CodeReviewSelection } from "./code-review";

export type ChangeSummaryRange = {
  scope: "working-tree" | "commits";
  base: string;
  target: string;
  baseLabel: string;
  targetLabel: string;
};

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
