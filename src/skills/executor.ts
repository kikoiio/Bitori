import type {Skill} from './types.js';
import {renderSkillBody} from './loader.js';

export interface ActiveSkill {name: string; body: string; allowedTools: string[]}

export class ActiveSkills {
  readonly #entries = new Map<string, ActiveSkill>();

  activate(name: string, body: string, allowedTools: readonly string[]): void { this.#entries.set(name, {name, body, allowedTools: [...allowedTools]}); }
  clear(): void { this.#entries.clear(); }
  list(): readonly ActiveSkill[] { return [...this.#entries.values()]; }
  render(): string {
    const entries = this.list();
    if (entries.length === 0) return '';
    return ['## Active Skills', ...entries.map(entry => `### Skill: ${entry.name}\n${entry.body}`)].join('\n\n');
  }
}

/** [s10] inline 返回主对话 prompt；fork 的独立执行由 AgentRunner 派生会话后回流摘要。 */
export class SkillExecutor {
  constructor(private readonly active: ActiveSkills) {}

  executeInline(skill: Skill, args: string): string {
    const body = renderSkillBody(skill.body, args);
    this.active.activate(skill.meta.name, body, skill.meta.allowedTools);
    return body;
  }
}
