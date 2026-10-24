export type SkillMode = 'inline' | 'fork';
export type SkillForkContext = 'none' | 'recent' | 'full';

export interface SkillMeta {
  name: string;
  description: string;
  allowedTools: string[];
  mode: SkillMode;
  forkContext: SkillForkContext;
  model: string | null;
}

export interface Skill {
  meta: SkillMeta;
  body: string;
  sourcePath: string;
  source: 'user' | 'project';
}

export interface SkillCatalogEntry {name: string; description: string; source: 'user' | 'project'}
