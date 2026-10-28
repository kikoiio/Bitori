import {homedir} from 'node:os';
import {MemoryExtractor} from '../memory/extractor.js';
import {MemoryManager} from '../memory/manager.js';
import {SkillLoader} from '../skills/loader.js';
import {ActiveSkills, SkillExecutor} from '../skills/executor.js';
import {TaskManager} from '../subagents/task-manager.js';
import type {AgentDefinition} from '../subagents/types.js';
import {loadAgentDefinitions} from '../subagents/loader.js';
import {TeamManager} from '../teams/team.js';
import {HookEngine} from '../hooks/engine.js';
import {loadHookConfigs} from '../hooks/loader.js';
import type {HookConfig} from '../hooks/types.js';
import type {LLMClient} from '../providers/types.js';

export interface AgentServices {
  skills: SkillLoader;
  activeSkills: ActiveSkills;
  skillExecutor: SkillExecutor;
  memory: MemoryManager;
  memoryExtractor: (client: LLMClient) => MemoryExtractor;
  tasks: TaskManager;
  agents: AgentDefinition[];
  teams: TeamManager;
  hooks: HookEngine;
  close: () => void;
}

/** 把各子系统接入同一个组合根，供工具与控制器共享。 */
export function createAgentServices(options: {workDir?: string; hooks?: readonly HookConfig[]} = {}): AgentServices {
  const workDir = options.workDir ?? process.cwd();
  const home = homedir();
  const skills = new SkillLoader(workDir, home);
  skills.loadAll();
  const activeSkills = new ActiveSkills();
  return {
    skills,
    activeSkills,
    skillExecutor: new SkillExecutor(activeSkills),
    memory: new MemoryManager(workDir, home),
    memoryExtractor: client => new MemoryExtractor(new MemoryManager(workDir, home), client),
    tasks: new TaskManager(),
    agents: loadAgentDefinitions(workDir, home),
    teams: new TeamManager(home),
    hooks: new HookEngine(options.hooks ?? loadHookConfigs(workDir)),
    close: () => undefined,
  };
}
