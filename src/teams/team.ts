import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

export type TeamStatus = 'active' | 'completed' | 'failed';

export interface TeamMember {
  name: string;
  role: string;
  status: 'running' | 'idle' | 'completed' | 'failed' | 'stopped';
  worktreePath: string | null;
}

export interface TeamRecord {name: string; description: string; lead: string; status: TeamStatus; members: TeamMember[]}

function sanitize(name: string): string { return name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64); }

/** 团队配置按名称持久化；邮箱与任务共享同一团队目录。 */
export class TeamManager {
  readonly #homeDirectory: string;

  constructor(homeDirectory: string) { this.#homeDirectory = homeDirectory; }

  create(name: string, description = ''): TeamRecord {
    const safeName = sanitize(name);
    if (!safeName) throw new Error('团队名称无效');
    const directory = this.directory(safeName);
    if (existsSync(directory)) throw new Error(`团队已存在：${safeName}`);
    mkdirSync(directory, {recursive: true});
    const team: TeamRecord = {name: safeName, description, lead: 'lead', status: 'active', members: []};
    writeFileSync(join(directory, 'team.json'), JSON.stringify(team), 'utf8');
    return team;
  }

  directory(name: string): string {
    const safeName = sanitize(name);
    if (!safeName) throw new Error('团队名称无效');
    return join(this.#homeDirectory, safeName);
  }

  get(name: string): TeamRecord | null {
    const path = join(this.directory(name), 'team.json');
    if (!existsSync(path)) return null;
    try { return JSON.parse(readFileSync(path, 'utf8')) as TeamRecord; }
    catch { return null; }
  }

  list(): TeamRecord[] {
    if (!existsSync(this.#homeDirectory)) return [];
    return readdirSync(this.#homeDirectory).map(entry => this.get(entry)).filter(Boolean) as TeamRecord[];
  }

  upsertMember(teamName: string, member: TeamMember): TeamRecord {
    const team = this.get(teamName);
    if (!team) throw new Error(`团队不存在：${teamName}`);
    const index = team.members.findIndex(item => item.name === member.name);
    if (index >= 0) team.members[index] = member;
    else team.members.push(member);
    this.save(team);
    return team;
  }

  setStatus(teamName: string, status: TeamStatus): void {
    const team = this.get(teamName);
    if (!team) throw new Error(`团队不存在：${teamName}`);
    team.status = status;
    this.save(team);
  }

  delete(name: string, force = false): void {
    const directory = this.directory(name);
    if (!existsSync(directory)) return;
    const team = this.get(name);
    if (!force && team?.members.some(member => member.status === 'running')) throw new Error('团队仍有运行中的成员，不能删除');
    rmSync(directory, {recursive: true, force: true});
  }

  save(team: TeamRecord): void { writeFileSync(join(this.directory(team.name), 'team.json'), JSON.stringify(team), 'utf8'); }
}
