import type {ToolDefinition} from '../tools/types.js';
import type {AgentDefinition} from './types.js';

export const GLOBAL_DISALLOWED_TOOLS = new Set(['agent']);
export const BACKGROUND_ALLOWED_TOOLS = new Set(['read_file', 'search_text', 'find_files']);

function normalize(names: readonly string[] | undefined): Set<string> {
  return new Set((names ?? []).map(name => name.toLowerCase()));
}

/** 全局禁用 → 角色黑名单 → 后台白名单 → 角色白名单，逐层收窄。 */
export function filterToolsForAgent(tools: readonly ToolDefinition[], definition: AgentDefinition, options: {background?: boolean} = {}): ToolDefinition[] {
  const disallowed = normalize(definition.disallowedTools);
  const allowed = normalize(definition.tools);
  return tools.filter(tool => {
    const name = tool.name.toLowerCase();
    if (GLOBAL_DISALLOWED_TOOLS.has(name)) return false;
    if (disallowed.has(name)) return false;
    if (options.background && !BACKGROUND_ALLOWED_TOOLS.has(name)) return false;
    if (allowed.size > 0 && !allowed.has(name)) return false;
    return true;
  });
}
