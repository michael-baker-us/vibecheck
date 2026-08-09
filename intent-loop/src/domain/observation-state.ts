import { AgentSummary } from "./agent-events";
import { Finding } from "./findings";
import { VerificationState } from "./verification";

export const OBSERVATION_STATE_VERSION = 2 as const;

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
  startedAt: string;
  lastUpdatedAt: string;
  paused: boolean;
  workingIntent?: string;
  changedFiles: ChangedFile[];
  findings: Finding[];
  verification: VerificationState[];
  trustedCommandHashes: string[];
  agent: AgentSummary;
};

export type ObservationSnapshot =
  | { kind: "unavailable"; reason: string }
  | { kind: "ready"; state: ObservationState };
