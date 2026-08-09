import { CodeReviewSelection, CodeReviewTranscriptEntry } from "./code-review";

export type InstructionRefreshScope = "instructions" | "supporting";

export type InstructionFilePath =
  | "AGENTS.md"
  | "CLAUDE.md"
  | ".codex/config.toml"
  | ".codex/hooks.json"
  | ".mcp.json"
  | ".claude/settings.json"
  | `.codex/rules/${string}.rules`
  | `.codex/agents/${string}.toml`
  | `.agents/skills/${string}/SKILL.md`
  | `.agents/skills/${string}/${"scripts" | "references" | "assets" | "agents"}/${string}`
  | `.claude/rules/${string}.md`
  | `.claude/agents/${string}.md`
  | `.claude/skills/${string}/SKILL.md`
  | `.claude/skills/${string}/${"scripts" | "references" | "assets" | "agents"}/${string}`
  | `.claude/output-styles/${string}.md`;

export type InstructionRefreshFilePreview = {
  path: InstructionFilePath;
  status: "created" | "modified" | "unchanged";
  rationale: string;
};

export type InstructionRefreshSession = CodeReviewSelection & {
  scope: InstructionRefreshScope;
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
