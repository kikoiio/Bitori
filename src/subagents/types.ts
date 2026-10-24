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
  {name: 'general-purpose', description: 'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.'},
  {name: 'plan', description: 'Software architect agent for designing implementation plans. Returns step-by-step plans, identifies critical files.', disallowedTools: ['edit_file', 'write_file', 'run_command'], permissionMode: 'plan'},
  {name: 'explore', description: 'Fast read-only search agent for locating code. Use it to find files by pattern, grep for symbols or keywords.', disallowedTools: ['edit_file', 'write_file', 'run_command'], permissionMode: 'plan', model: 'haiku'},
];
