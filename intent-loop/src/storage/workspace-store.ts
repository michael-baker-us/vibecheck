import * as vscode from "vscode";

import {
  OBSERVATION_STATE_VERSION,
  ObservationState,
} from "../domain/observation-state";

const OBSERVATION_STATE_KEY = "intentLoop.observationState.v3";
const VERSION_TWO_STATE_KEY = "intentLoop.observationState.v2";
const LEGACY_STATE_KEY = "intentLoop.observationState.v1";

type LegacyObservationState = {
  workspaceRoot: string;
  repositoryRoot: string;
  baselineCommit: string;
  startedAt: string;
  lastUpdatedAt: string;
  paused: boolean;
  changedPaths: string[];
};

type VersionTwoObservationState = Omit<ObservationState, "version" | "planCandidates"> & {
  version: 2;
  workingIntent?: string;
};

export class WorkspaceStore {
  public constructor(private readonly state: vscode.Memento) {}

  public getObservation(): ObservationState | undefined {
    const current = this.state.get<ObservationState>(OBSERVATION_STATE_KEY);
    if (current?.version === OBSERVATION_STATE_VERSION) {
      return current;
    }

    const versionTwo = this.state.get<VersionTwoObservationState>(VERSION_TWO_STATE_KEY);
    if (versionTwo?.version === 2) {
      const { workingIntent: _workingIntent, ...rest } = versionTwo;
      return { ...rest, version: OBSERVATION_STATE_VERSION, planCandidates: [] };
    }

    const legacy = this.state.get<LegacyObservationState>(LEGACY_STATE_KEY);
    if (!legacy) return undefined;
    return {
      ...legacy,
      version: OBSERVATION_STATE_VERSION,
      planCandidates: [],
      changedFiles: legacy.changedPaths.map((path) => ({
        path,
        status: "modified" as const,
        binary: false,
      })),
      findings: [],
      verification: [],
      trustedCommandHashes: [],
      agent: { connectedAgents: [] },
    };
  }

  public async saveObservation(observation: ObservationState): Promise<void> {
    await this.state.update(OBSERVATION_STATE_KEY, observation);
    await Promise.all([
      this.state.update(VERSION_TWO_STATE_KEY, undefined),
      this.state.update(LEGACY_STATE_KEY, undefined),
    ]);
  }

  public async deleteObservation(): Promise<void> {
    await Promise.all([
      this.state.update(OBSERVATION_STATE_KEY, undefined),
      this.state.update(VERSION_TWO_STATE_KEY, undefined),
      this.state.update(LEGACY_STATE_KEY, undefined),
    ]);
  }
}
