export type SubAgentPermissionMode = 'plan' | 'execute';

export interface AgentDefinition {
  name: string;
  description: string;
  tools?: string[];
  disallowedTools?: string[];
  systemPromptOverride?: string;
  maxTurns?: number;
  model?: string;
  permissionMode?: SubAgentPermissionMode;
  background?: boolean;
  initialPrompt?: string;
}

export const BUILTIN_AGENTS: readonly AgentDefinition[] = [
  {name: 'general-purpose', description: 'Text-only consultation based on the information supplied in the prompt; no tools or workspace access.'},
  {name: 'plan', description: 'Text-only planning consultation based on supplied context; no tools or workspace access.'},
  {name: 'explore', description: 'Text-only analysis of supplied material; cannot search or inspect files.', model: 'haiku'},
];
