export type AgentFileOwner = "codex" | "claude" | "vibecheck";
export type AgentFileKind =
  | "instructions"
  | "skills"
  | "prompts"
  | "agents"
  | "settings"
  | "rules"
  | "hooks"
  | "mcp"
  | "plugins"
  | "output-styles";

export type AgentWorkspaceFile = {
  path: string;
  title: string;
  owner: AgentFileOwner;
  kind: AgentFileKind;
  exists: boolean;
  localOnly: boolean;
  description: string;
};
