export interface SkillMeta {
  name: string;
  description: string;
  unsupportedFields?: string[];
}

export interface Skill {
  meta: SkillMeta;
  body: string;
  sourcePath: string;
  source: 'user' | 'project';
}

export interface SkillCatalogEntry {name: string; description: string; source: 'user' | 'project'}
