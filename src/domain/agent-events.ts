export type AgentName = "codex" | "claude" | "unknown";

export const AGENT_EVENT_TYPES = [
  "session-start",
  "session-end",
  "prompt",
  "tool-started",
  "tool-finished",
  "subagent-start",
  "subagent-stop",
  "turn-stop",
] as const;

export type AgentEventType = typeof AGENT_EVENT_TYPES[number];

/**
 * A single lifecycle signal from a Codex or Claude session, written by the local hook bridge.
 *
 * Version 1 events omit `member` and the subagent and tool-started types; the reader still accepts
 * them, because the bridge is only replaced when the user reinstalls the adapter.
 *
 * `member` is the one piece of delegation content recorded anywhere. It carries a subagent
 * identifier and is bounded twice: structurally by the bridge, then against the configured roster
 * before it reaches workspace state. Task descriptions and all other tool arguments are never read.
 */
export type AgentEvent = {
  version: 1 | 2;
  id: string;
  agent: AgentName;
  type: AgentEventType;
  workspace?: string;
  sessionId?: string;
  tool?: string;
  member?: string;
  command?: string;
  exitCode?: number;
  at: string;
};

export type AgentSummary = {
  connectedAgents: AgentName[];
  lastEventAt?: string;
  lastEventType?: AgentEventType;
};
