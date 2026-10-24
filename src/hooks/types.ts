export const hookEvents = [
  'session_start', 'session_end', 'turn_start', 'turn_end', 'pre_send', 'post_receive',
  'pre_tool_use', 'post_tool_use', 'startup', 'shutdown', 'error', 'compact', 'permission_request', 'file_change', 'command_execute',
] as const;

export type HookEvent = (typeof hookEvents)[number];
export type HookActionType = 'command' | 'prompt' | 'http' | 'agent';

export interface HookAction {
  type: HookActionType;
  command?: string;
  url?: string;
  method?: string;
  prompt?: string;
}

export interface HookConfig {
  id?: string;
  event: HookEvent;
  condition?: string;
  action: HookAction;
  reject?: boolean;
  once?: boolean;
  async?: boolean;
  timeoutMs?: number;
}

export interface HookContext {
  event: HookEvent;
  toolName?: string;
  args?: Record<string, unknown>;
  filePath?: string;
  message?: string;
  error?: string;
}

export interface HookResult {output: string; success: boolean; reject: boolean}
