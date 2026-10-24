import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {FileMailbox} from '../../../src/teams/file-mailbox.js';
import {TeamManager} from '../../../src/teams/team.js';
import {createProgress, recordToolUse, summarizeActivities} from '../../../src/teams/progress.js';

describe('Agent Teams', () => {
  it('文件邮箱支持发送、游标恢复与标记已读', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bitori-mail-'));
    const mailbox = new FileMailbox(directory, 'alice');
    await mailbox.send('lead', 'hi');
    await mailbox.send('lead', 'second');
    await expect(mailbox.receive()).resolves.toHaveLength(2);
    await expect(mailbox.receive()).resolves.toEqual([]);
    expect(new FileMailbox(directory, 'alice').unreadCount()).toBe(0);
    await mailbox.send('lead', 'third');
    expect(mailbox.unreadCount()).toBe(1);
    mailbox.markAllRead();
    expect(mailbox.unreadCount()).toBe(0);
  });

  it('团队创建、成员更新、状态保护与删除', () => {
    const home = mkdtempSync(join(tmpdir(), 'bitori-teams-'));
    const manager = new TeamManager(home);
    const team = manager.create('Review Team!');
    expect(team.name).toBe('Review-Team');
    expect(manager.list().map(item => item.name)).toEqual(['Review-Team']);
    manager.upsertMember(team.name, {name: 'alice', role: 'reviewer', status: 'running', worktreePath: null});
    expect(() => manager.delete(team.name)).toThrow('运行中的成员');
    manager.upsertMember(team.name, {name: 'alice', role: 'reviewer', status: 'idle', worktreePath: null});
    manager.delete(team.name);
    expect(manager.get(team.name)).toBeNull();
  });

  it('进度活动描述只保留最近五条', () => {
    const progress = createProgress();
    for (let index = 0; index < 7; index++) recordToolUse(progress, 'read_file', {file_path: `/file-${index}`});
    expect(progress.toolUseCount).toBe(7);
    expect(progress.recentActivities).toHaveLength(5);
    expect(summarizeActivities(progress.recentActivities)).toBe('Reading /file-6');
    recordToolUse(progress, 'run_command', {command: 'x'.repeat(50)});
    expect(summarizeActivities(progress.recentActivities)).toMatch(/^Running x{40}\.\.\.$/);
  });
});
