import * as vscode from "vscode";

import {
  OBSERVATION_STATE_VERSION,
  ObservationState,
} from "../domain/observation-state";
import { EMPTY_TEAM_ACTIVITY } from "../domain/team";

const OBSERVATION_STATE_KEY = "vibecheck.observationState.v8";
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

/** v7 predates team activity; the field is simply absent and defaults to empty. */
type VersionSevenObservationState = Omit<ObservationState, "version" | "teamActivity"> & {
  version: 7;
};

type VersionSixObservationState = Omit<ObservationState, "version" | "codeReview" | "teamActivity"> & {
  version: 6;
  codeReview?: Omit<NonNullable<ObservationState["codeReview"]>, "profile" | "model" | "effort">;
};

type VersionFiveObservationState = Omit<ObservationState, "teamActivity" | "version" | "codeReview"> & {
  version: 5;
  codeReview?: Omit<NonNullable<ObservationState["codeReview"]>, "baselineCommit" | "activity" | "profile" | "model" | "effort">;
};

type VersionFourObservationState = Omit<ObservationState, "teamActivity" | "version" | "codeReview"> & {
  version: 4;
};

type VersionThreeObservationState = Omit<ObservationState, "teamActivity" | "version" | "agentFiles"> & {
  version: 3;
};

type VersionTwoObservationState = Omit<ObservationState, "teamActivity" | "version" | "planCandidates" | "agentFiles"> & {
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

    const versionSeven = this.state.get<VersionSevenObservationState>(VERSION_SEVEN_STATE_KEY);
    if (versionSeven?.version === 7) {
      return { ...versionSeven, version: OBSERVATION_STATE_VERSION, teamActivity: EMPTY_TEAM_ACTIVITY };
    }

    const versionSix = this.state.get<VersionSixObservationState>(VERSION_SIX_STATE_KEY);
    if (versionSix?.version === 6) {
      return {
        ...versionSix,
        version: OBSERVATION_STATE_VERSION,
        teamActivity: EMPTY_TEAM_ACTIVITY,
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
        ...versionFive,
        version: OBSERVATION_STATE_VERSION,
        teamActivity: EMPTY_TEAM_ACTIVITY,
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
      return { ...versionFour, version: OBSERVATION_STATE_VERSION, teamActivity: EMPTY_TEAM_ACTIVITY };
    }

    const versionThree = this.state.get<VersionThreeObservationState>(VERSION_THREE_STATE_KEY);
    if (versionThree?.version === 3) {
      return { ...versionThree, version: OBSERVATION_STATE_VERSION, agentFiles: [], teamActivity: EMPTY_TEAM_ACTIVITY };
    }

    const versionTwo = this.state.get<VersionTwoObservationState>(VERSION_TWO_STATE_KEY);
    if (versionTwo?.version === 2) {
      const { workingIntent: _workingIntent, ...rest } = versionTwo;
      return { ...rest, version: OBSERVATION_STATE_VERSION, planCandidates: [], agentFiles: [], teamActivity: EMPTY_TEAM_ACTIVITY };
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
      agent: { connectedAgents: [] },
      teamActivity: EMPTY_TEAM_ACTIVITY,
    };
  }

  public async saveObservation(observation: ObservationState): Promise<void> {
    await this.state.update(OBSERVATION_STATE_KEY, observation);
    await Promise.all([
      this.state.update(VERSION_TWO_STATE_KEY, undefined),
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
      this.state.update(VERSION_THREE_STATE_KEY, undefined),
      this.state.update(VERSION_FOUR_STATE_KEY, undefined),
      this.state.update(VERSION_FIVE_STATE_KEY, undefined),
      this.state.update(VERSION_SIX_STATE_KEY, undefined),
      this.state.update(VERSION_SEVEN_STATE_KEY, undefined),
      this.state.update(LEGACY_STATE_KEY, undefined),
    ]);
  }
}
