import { CodeReviewSelection, CodeReviewTranscriptEntry } from "./code-review";

export type InstructionFilePath = "AGENTS.md" | "CLAUDE.md";

export type InstructionRefreshFilePreview = {
  path: InstructionFilePath;
  status: "created" | "modified" | "unchanged";
};

export type InstructionRefreshSession = CodeReviewSelection & {
  status: "running" | "preview" | "applied" | "discarded" | "failed";
  startedAt: string;
  finishedAt?: string;
  transcript: CodeReviewTranscriptEntry[];
  summary?: string;
  files: InstructionRefreshFilePreview[];
  error?: string;
};

export type InstructionRefreshFileProposal = InstructionRefreshFilePreview & {
  originalContent?: string;
  proposedContent: string;
};

export type InstructionRefreshProposal = {
  summary: string;
  files: InstructionRefreshFileProposal[];
};

export type InstructionRefreshApplyResult = {
  changedFiles: InstructionFilePath[];
  backupDirectory?: string;
};
