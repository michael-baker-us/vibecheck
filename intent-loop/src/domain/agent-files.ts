export type AgentFileOwner = "codex" | "claude" | "intent-loop";
export type AgentFileKind = "instructions" | "settings" | "rules";

export type AgentWorkspaceFile = {
  path: string;
  title: string;
  owner: AgentFileOwner;
  kind: AgentFileKind;
  exists: boolean;
  localOnly: boolean;
  description: string;
};
