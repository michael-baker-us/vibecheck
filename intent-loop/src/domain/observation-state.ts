import { AgentSummary } from "./agent-events";
import { AgentWorkspaceFile } from "./agent-files";
import { Finding } from "./findings";
import { PlanDocument } from "./plans";
import { VerificationState } from "./verification";

export const OBSERVATION_STATE_VERSION = 4 as const;

export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed";

export type ChangedFile = {
  path: string;
  previousPath?: string;
  status: FileChangeStatus;
  binary: boolean;
  before?: string;
  after?: string;
};

export type ObservationState = {
  version: typeof OBSERVATION_STATE_VERSION;
  workspaceRoot: string;
  repositoryRoot: string;
  baselineCommit: string;
  headBranch?: string;
  headSubject?: string;
  startedAt: string;
  lastUpdatedAt: string;
  paused: boolean;
  selectedPlanPath?: string;
  activePlan?: PlanDocument;
  planCandidates: PlanDocument[];
  agentFiles: AgentWorkspaceFile[];
  changedFiles: ChangedFile[];
  findings: Finding[];
  verification: VerificationState[];
  trustedCommandHashes: string[];
  agent: AgentSummary;
};

export type ObservationSnapshot =
  | { kind: "unavailable"; reason: string }
  | { kind: "ready"; state: ObservationState };
