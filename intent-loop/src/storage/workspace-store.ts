import * as vscode from "vscode";

import { ObservationState } from "../domain/observation-state";

const OBSERVATION_STATE_KEY = "intentLoop.observationState.v1";

export class WorkspaceStore {
  public constructor(private readonly state: vscode.Memento) {}

  public getObservation(): ObservationState | undefined {
    return this.state.get<ObservationState>(OBSERVATION_STATE_KEY);
  }

  public async saveObservation(observation: ObservationState): Promise<void> {
    await this.state.update(OBSERVATION_STATE_KEY, observation);
  }

  public async deleteObservation(): Promise<void> {
    await this.state.update(OBSERVATION_STATE_KEY, undefined);
  }
}
