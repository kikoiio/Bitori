import {homedir} from 'node:os';
import {MemoryExtractor} from '../memory/extractor.js';
import {MemoryManager} from '../memory/manager.js';
import {SkillLoader} from '../skills/loader.js';
import {ActiveSkills, SkillExecutor} from '../skills/executor.js';
import type {AgentDefinition} from '../subagents/types.js';
import {loadAgentDefinitions} from '../subagents/loader.js';
import {TeamManager} from '../teams/team.js';
import {HookEngine} from '../hooks/engine.js';
import {loadHookConfigs} from '../hooks/loader.js';
import {isWorkspaceTrusted} from '../config/trust.js';
import type {HookConfig} from '../hooks/types.js';
import type {LLMClient} from '../providers/types.js';
import {join} from 'node:path';

export interface AgentServices {
  projectTrusted: boolean;
  skills: SkillLoader;
  activeSkills: ActiveSkills;
  skillExecutor: SkillExecutor;
  memory: MemoryManager;
  memoryExtractor: (client: LLMClient) => MemoryExtractor;
  agents: AgentDefinition[];
  teams: TeamManager;
  hooks: HookEngine;
  close: () => Promise<void>;
}

/** 把各子系统接入同一个组合根，供工具与控制器共享。 */
export function createAgentServices(options: {workDir?: string; hooks?: readonly HookConfig[]; projectTrusted?: boolean} = {}): AgentServices {
  const workDir = options.workDir ?? process.cwd();
  const home = homedir();
  const projectTrusted = options.projectTrusted ?? isWorkspaceTrusted(workDir, home);
  // 项目内容可能影响模型指令或启动进程；信任前统一跳过项目级来源。
  const skills = new SkillLoader(workDir, home, projectTrusted);
  skills.loadAll();
  const activeSkills = new ActiveSkills();
  const memory = new MemoryManager(workDir, home, projectTrusted);
  const extractors = new WeakMap<LLMClient, MemoryExtractor>();
  const ownedExtractors = new Set<MemoryExtractor>();
  let closed: Promise<void> | undefined;
  return {
    projectTrusted,
    skills,
    activeSkills,
    skillExecutor: new SkillExecutor(activeSkills),
    memory,
    memoryExtractor: client => {
      if (closed) throw new Error('Agent 服务已经关闭');
      const existing = extractors.get(client);
      if (existing) return existing;
      const extractor = new MemoryExtractor(memory, client);
      extractors.set(client, extractor);
      ownedExtractors.add(extractor);
      return extractor;
    },
    agents: loadAgentDefinitions(workDir, home, projectTrusted),
    teams: new TeamManager(join(home, '.bitori', 'teams')),
    hooks: new HookEngine(options.hooks ?? loadHookConfigs(workDir, home, projectTrusted)),
    close: () => closed ??= Promise.all([...ownedExtractors].map(extractor => extractor.close())).then(() => { ownedExtractors.clear(); }),
  };
}
