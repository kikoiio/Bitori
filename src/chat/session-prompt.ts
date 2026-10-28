import type {AgentServices} from '../agent/services.js';
import type {ProviderProfile} from '../config/types.js';
import {loadInstructions} from '../memory/instructions.js';
import {buildSystemPrompt, SECTION_PRIORITY} from '../prompt/builder.js';
import type {PromptBlock, PromptSection} from '../prompt/builder.js';
import {collectEnvironment} from '../prompt/environment.js';

/** 会话激活时构建提示，调用方在整个会话期间保留结果。 */
export function buildSessionPrompt(profile: ProviderProfile, workspaceRoot: string, services: AgentServices | null): PromptBlock[] {
  const optional: PromptSection[] = [];
  const instructions = services ? loadInstructions(workspaceRoot) : '';
  if (instructions) optional.push({id: 'customInstructions', priority: SECTION_PRIORITY.customInstructions, text: instructions});
  const memory = services?.memory.buildSystemReminder() ?? '';
  if (memory) optional.push({id: 'longTermMemory', priority: SECTION_PRIORITY.longTermMemory, text: memory});
  const skills = services?.skills.catalog() ?? [];
  if (skills.length > 0) optional.push({id: 'skills', priority: SECTION_PRIORITY.skills, text: ['Available skills:', ...skills.map(skill => `- ${skill.name}: ${skill.description}`), '', 'Use load_skill to activate one before following its SOP.'].join('\n')});
  return buildSystemPrompt(collectEnvironment(profile, workspaceRoot), optional).blocks;
}
