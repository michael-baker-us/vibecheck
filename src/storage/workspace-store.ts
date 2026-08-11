import * as vscode from "vscode";

import {
  OBSERVATION_STATE_VERSION,
  ObservationState,
} from "../domain/observation-state";

const OBSERVATION_STATE_KEY = "vibecheck.observationState.v9";
const VERSION_EIGHT_STATE_KEY = "vibecheck.observationState.v8";
const VERSION_SEVEN_STATE_KEY = "vibecheck.observationState.v7";
const VERSION_SIX_STATE_KEY = "vibecheck.observationState.v6";
const VERSION_FIVE_STATE_KEY = "vibecheck.observationState.v5";
const VERSION_FOUR_STATE_KEY = "vibecheck.observationState.v4";
const VERSION_THREE_STATE_KEY = "vibecheck.observationState.v3";
const VERSION_TWO_STATE_KEY = "vibecheck.observationState.v2";
const LEGACY_STATE_KEY = "vibecheck.observationState.v1";

type LegacyObservationState = {
  workspaceRoot: string;
  repositoryRoot: string;
  baselineCommit: string;
  startedAt: string;
  lastUpdatedAt: string;
  paused: boolean;
  changedPaths: string[];
};

type VersionEightObservationState = Omit<ObservationState, "version"> & {
  version: 8;
  agent?: unknown;
  teamActivity?: unknown;
};

type VersionSevenObservationState = Omit<ObservationState, "version"> & {
  version: 7;
};

type VersionSixObservationState = Omit<ObservationState, "version" | "codeReview"> & {
  version: 6;
  codeReview?: Omit<NonNullable<ObservationState["codeReview"]>, "profile" | "model" | "effort">;
};

type VersionFiveObservationState = Omit<ObservationState, "version" | "codeReview"> & {
  version: 5;
  codeReview?: Omit<NonNullable<ObservationState["codeReview"]>, "baselineCommit" | "activity" | "profile" | "model" | "effort">;
};

type VersionFourObservationState = Omit<ObservationState, "version" | "codeReview"> & {
  version: 4;
};

type VersionThreeObservationState = Omit<ObservationState, "version" | "agentFiles"> & {
  version: 3;
};

type VersionTwoObservationState = Omit<ObservationState, "version" | "planCandidates" | "agentFiles"> & {
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

    const versionEight = this.state.get<VersionEightObservationState>(VERSION_EIGHT_STATE_KEY);
    if (versionEight?.version === 8) {
      const rest = stripLegacyMonitoring(versionEight);
      return { ...rest, version: OBSERVATION_STATE_VERSION };
    }

    const versionSeven = this.state.get<VersionSevenObservationState>(VERSION_SEVEN_STATE_KEY);
    if (versionSeven?.version === 7) {
      return { ...stripLegacyMonitoring(versionSeven), version: OBSERVATION_STATE_VERSION };
    }

    const versionSix = this.state.get<VersionSixObservationState>(VERSION_SIX_STATE_KEY);
    if (versionSix?.version === 6) {
      return {
        ...stripLegacyMonitoring(versionSix),
        version: OBSERVATION_STATE_VERSION,
        codeReview: versionSix.codeReview ? {
          ...versionSix.codeReview,
          profile: "deep",
          model: "CLI default",
          effort: "high",
        } : undefined,
      };
    }

    const versionFive = this.state.get<VersionFiveObservationState>(VERSION_FIVE_STATE_KEY);
    if (versionFive?.version === 5) {
      return {
        ...stripLegacyMonitoring(versionFive),
        version: OBSERVATION_STATE_VERSION,
        codeReview: versionFive.codeReview ? {
          ...versionFive.codeReview,
          baselineCommit: versionFive.baselineCommit,
          activity: [],
          profile: "deep",
          model: "CLI default",
          effort: "high",
        } : undefined,
      };
    }

    const versionFour = this.state.get<VersionFourObservationState>(VERSION_FOUR_STATE_KEY);
    if (versionFour?.version === 4) {
      return { ...stripLegacyMonitoring(versionFour), version: OBSERVATION_STATE_VERSION };
    }

    const versionThree = this.state.get<VersionThreeObservationState>(VERSION_THREE_STATE_KEY);
    if (versionThree?.version === 3) {
      return { ...stripLegacyMonitoring(versionThree), version: OBSERVATION_STATE_VERSION, agentFiles: [] };
    }

    const versionTwo = this.state.get<VersionTwoObservationState>(VERSION_TWO_STATE_KEY);
    if (versionTwo?.version === 2) {
      const { workingIntent: _workingIntent, ...rest } = stripLegacyMonitoring(versionTwo);
      return { ...rest, version: OBSERVATION_STATE_VERSION, planCandidates: [], agentFiles: [] };
    }

    const legacy = this.state.get<LegacyObservationState>(LEGACY_STATE_KEY);
    if (!legacy) return undefined;
    return {
      ...legacy,
      version: OBSERVATION_STATE_VERSION,
      planCandidates: [],
      agentFiles: [],
      changedFiles: legacy.changedPaths.map((path) => ({
        path,
        status: "modified" as const,
        binary: false,
      })),
      findings: [],
      verification: [],
      trustedCommandHashes: [],
    };
  }

  public async saveObservation(observation: ObservationState): Promise<void> {
    await this.state.update(OBSERVATION_STATE_KEY, observation);
    await Promise.all([
      this.state.update(VERSION_TWO_STATE_KEY, undefined),
      this.state.update(VERSION_EIGHT_STATE_KEY, undefined),
      this.state.update(VERSION_THREE_STATE_KEY, undefined),
      this.state.update(VERSION_FOUR_STATE_KEY, undefined),
      this.state.update(VERSION_FIVE_STATE_KEY, undefined),
      this.state.update(VERSION_SIX_STATE_KEY, undefined),
      this.state.update(VERSION_SEVEN_STATE_KEY, undefined),
      this.state.update(LEGACY_STATE_KEY, undefined),
    ]);
  }

  public async deleteObservation(): Promise<void> {
    await Promise.all([
      this.state.update(OBSERVATION_STATE_KEY, undefined),
      this.state.update(VERSION_TWO_STATE_KEY, undefined),
      this.state.update(VERSION_EIGHT_STATE_KEY, undefined),
      this.state.update(VERSION_THREE_STATE_KEY, undefined),
      this.state.update(VERSION_FOUR_STATE_KEY, undefined),
      this.state.update(VERSION_FIVE_STATE_KEY, undefined),
      this.state.update(VERSION_SIX_STATE_KEY, undefined),
      this.state.update(VERSION_SEVEN_STATE_KEY, undefined),
      this.state.update(LEGACY_STATE_KEY, undefined),
    ]);
  }
}

function stripLegacyMonitoring<T extends object>(value: T): Omit<T, "agent" | "teamActivity"> {
  const { agent: _agent, teamActivity: _teamActivity, ...rest } = value as T & {
    agent?: unknown;
    teamActivity?: unknown;
  };
  return rest;
}
