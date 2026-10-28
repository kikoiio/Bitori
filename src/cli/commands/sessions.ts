import {configPaths, loadConfig, resolveProfile} from '../../config/loader.js';
import {UsageError} from '../../shared/errors.js';
import {SessionRepository} from '../../storage/repository.js';
import type {CliOptions} from '../args.js';

/** `bitori sessions …` 只读命令入口；返回进程退出码。 */
export async function runSessionsCommand(options: NonNullable<CliOptions['sessions']>, profileOption?: string): Promise<number> {
  const config = loadConfig();
  const profile = resolveProfile(config, profileOption);
  if (profile === null) throw new UsageError('多 profile 时 sessions 命令需要 --profile 指定');
  const repository = new SessionRepository(configPaths().database);
  try {
    // 只读命令不应把其他进程留下的活动回合改写成中断状态。
    await repository.initialize({recover: false});
    if (options.action === 'list') {
      const sessions = await repository.listSessions(profile.name);
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
        return 0;
      }
      if (sessions.length === 0) { process.stdout.write(`（profile ${profile.name} 暂无会话）\n`); return 0; }
      process.stdout.write('会话 ID                            模式      创建时间             消息\n');
      for (const session of sessions) {
        const conversation = await repository.getConversation(session.id);
        process.stdout.write(`${session.id.padEnd(34)} ${session.agentMode.padEnd(8)} ${new Date(session.createdAt).toISOString().padEnd(20)} ${conversation?.messages.length ?? 0}\n`);
      }
      return 0;
    }
    // show
    if (options.sessionId === undefined) throw new UsageError('sessions show 需要 <sessionId>');
    const session = await repository.getSession(options.sessionId);
    if (!session || session.profileName !== profile.name) { process.stdout.write('会话不存在或不属于当前 profile\n'); return 1; }
    const conversation = await repository.getConversation(session.id);
    if (options.json === true) {
      process.stdout.write(`${JSON.stringify({session, conversation}, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(`会话 ${session.id} · profile ${session.profileName} · 模式 ${session.agentMode} · 创建 ${new Date(session.createdAt).toISOString()}\n`);
    const runs = conversation?.agentRuns ?? [];
    process.stdout.write(`Agent 回合 ${runs.length} 个；累计 token：${runs.reduce((sum, run) => sum + run.inputTokens, 0)}↓ ${runs.reduce((sum, run) => sum + run.outputTokens, 0)}↑\n`);
    for (const run of runs) process.stdout.write(`  run ${run.id.slice(0, 8)} 模式 ${run.mode} 状态 ${run.status} 停止 ${run.stopReason} 迭代 ${run.iterationCount}\n`);
    const toolCalls = conversation?.toolCalls ?? [];
    process.stdout.write(`工具调用 ${toolCalls.length} 次；技能激活：\n`);
    for (const call of toolCalls.filter(item => item.toolName === 'load_skill')) process.stdout.write(`  load_skill ${JSON.stringify(call.arguments)} → ${call.executionStatus}\n`);
    process.stdout.write(`消息 ${conversation?.messages.length ?? 0} 条\n`);
    return 0;
  } finally {
    await repository.close();
  }
}
