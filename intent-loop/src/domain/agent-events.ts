export type AgentName = "codex" | "claude" | "unknown";

export type AgentEvent = {
  version: 1;
  id: string;
  agent: AgentName;
  type: "session-start" | "session-end" | "prompt" | "tool-finished" | "turn-stop";
  workspace?: string;
  sessionId?: string;
  tool?: string;
  command?: string;
  exitCode?: number;
  at: string;
};

export type AgentSummary = {
  connectedAgents: AgentName[];
  lastEventAt?: string;
  lastEventType?: AgentEvent["type"];
};
