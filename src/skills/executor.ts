import type {Skill} from './types.js';

export class UnsupportedSkillConfigurationError extends Error {}

export interface ActiveSkill {name: string; body: string}

export class ActiveSkills {
  readonly #entries = new Map<string, ActiveSkill>();

  activate(name: string, body: string): void { this.#entries.set(name, {name, body}); }
  deactivate(name: string): void { this.#entries.delete(name); }
  clear(): void { this.#entries.clear(); }
  list(): readonly ActiveSkill[] { return [...this.#entries.values()]; }
  render(): string {
    const entries = this.list();
    if (entries.length === 0) return '';
    return ['## Active Skills', ...entries.map(entry => `### Skill: ${entry.name}\n${entry.body}`)].join('\n\n');
  }
}

/** 激活 inline Skill 并返回正文。 */
export class SkillExecutor {
  constructor(private readonly active: ActiveSkills) {}

  executeInline(skill: Skill): string {
    if (skill.meta.unsupportedFields?.length) {
      this.active.deactivate(skill.meta.name);
      throw new UnsupportedSkillConfigurationError(`Skill 包含未支持的执行配置：${skill.meta.unsupportedFields.join(', ')}`);
    }
    const body = skill.body.replaceAll('$ARGUMENTS', '');
    this.active.activate(skill.meta.name, body);
    return body;
  }
}
