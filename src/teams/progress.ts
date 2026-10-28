export interface ToolActivity {toolName: string; input: Record<string, unknown>; activityDescription: string}
export interface AgentProgress {toolUseCount: number; tokenCount: number; lastActivity?: ToolActivity; recentActivities: ToolActivity[]}

export function createProgress(): AgentProgress { return {toolUseCount: 0, tokenCount: 0, recentActivities: []}; }

function describe(toolName: string, input: Record<string, unknown>): string {
  const value = (key: string): string => {
    const item = input[key];
    return typeof item === 'string' ? item : JSON.stringify(item ?? '');
  };
  if (toolName === 'read_file') return `Reading ${value('file_path') || 'file'}`;
  if (toolName === 'edit_file' || toolName === 'write_file') return `${toolName === 'edit_file' ? 'Editing' : 'Writing'} ${value('file_path') || 'file'}`;
  if (toolName === 'run_command') {
    const command = value('command');
    return `Running ${command.length > 40 ? `${command.slice(0, 40)}...` : command}`;
  }
  if (toolName === 'find_files') return `Searching ${value('pattern') || 'files'}`;
  if (toolName === 'search_text') return `Grepping ${value('pattern') || 'pattern'}`;
  return toolName;
}

/** 只保留最近 5 条活动，供终端 spinner 与团队状态栏展示。 */
export function recordToolUse(progress: AgentProgress, toolName: string, input: Record<string, unknown>): void {
  const activity: ToolActivity = {toolName, input, activityDescription: describe(toolName, input)};
  progress.toolUseCount++;
  progress.lastActivity = activity;
  progress.recentActivities.push(activity);
  if (progress.recentActivities.length > 5) progress.recentActivities.shift();
}

export function recordTokens(progress: AgentProgress, inputTokens: number, outputTokens: number): void { progress.tokenCount = inputTokens + outputTokens; }
export function summarizeActivities(activities: readonly ToolActivity[]): string { return activities.at(-1)?.activityDescription ?? ''; }
