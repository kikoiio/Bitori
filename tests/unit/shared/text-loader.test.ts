import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {parseSkillText} from '../../../src/skills/parser.js';
import {parseAgentDefinition} from '../../../src/subagents/loader.js';
import {loadUserCommands} from '../../../src/commands/loader.js';
import {MemoryManager, parseFrontmatter} from '../../../src/memory/manager.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });

describe('Markdown 扩展的换行兼容', () => {
  it('LF 与 CRLF 对 Skill、SubAgent 和记忆元数据给出相同结果', () => {
    const lf = '---\nname: demo\ndescription: 说明\n---\n正文';
    const crlf = lf.replaceAll('\n', '\r\n');
    expect(parseSkillText(crlf)).toEqual(parseSkillText(lf));
    expect(parseAgentDefinition(crlf)).toEqual(parseAgentDefinition(lf));
    expect(parseFrontmatter(crlf)).toEqual(parseFrontmatter(lf));
  });

  it('CRLF 自定义命令仍移除元数据并保留正文', () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-crlf-')); roots.push(root);
    mkdirSync(join(root, '.bitori', 'commands'), {recursive: true});
    writeFileSync(join(root, '.bitori', 'commands', 'review.md'), '---\r\ndescription: 审查\r\n---\r\n检查 $ARGUMENTS', 'utf8');
    const command = loadUserCommands(root, join(root, 'home')).find('review');
    expect(command?.type === 'prompt' && command.handler({workDir: root, args: 'src'})).toBe('检查 src');
    const manager = new MemoryManager(root, join(root, 'home'));
    manager.write('project', 'note', {name: '知识', description: '说明', type: 'project'}, '内容');
    const path = join(root, '.bitori', 'memory', 'note.md');
    writeFileSync(path, readFileAsCrLf(path), 'utf8');
    expect(manager.loadAll()[0]?.content).toBe('内容');
  });
});

function readFileAsCrLf(path: string): string {
  return readFileSync(path, 'utf8').replaceAll('\n', '\r\n');
}
