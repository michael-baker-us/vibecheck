export type ModelRouting = {
  codexBalanced: string;
  codexDeep: string;
  claudeBalanced: string;
  claudeDeep: string;
};

export const DEFAULT_MODEL_ROUTING: ModelRouting = {
  codexBalanced: "gpt-5.6-terra",
  codexDeep: "gpt-5.6-sol",
  claudeBalanced: "claude-sonnet-5",
  claudeDeep: "claude-opus-5",
};

export const MODEL_ROUTING_SETTINGS: Record<keyof ModelRouting, string> = {
  codexBalanced: "codexBalancedModel",
  codexDeep: "codexDeepModel",
  claudeBalanced: "claudeBalancedModel",
  claudeDeep: "claudeDeepModel",
};

export function normalizeModelRouting(value: Partial<ModelRouting>): ModelRouting {
  return {
    codexBalanced: validModel(value.codexBalanced, DEFAULT_MODEL_ROUTING.codexBalanced),
    codexDeep: validModel(value.codexDeep, DEFAULT_MODEL_ROUTING.codexDeep),
    claudeBalanced: validModel(value.claudeBalanced, DEFAULT_MODEL_ROUTING.claudeBalanced),
    claudeDeep: validModel(value.claudeDeep, DEFAULT_MODEL_ROUTING.claudeDeep),
  };
}

function validModel(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= 120 && !/[\r\n\0]/.test(trimmed) ? trimmed : fallback;
}
