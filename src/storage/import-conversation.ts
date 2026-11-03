import type {DatabaseSync} from 'node:sqlite';
import {createId, now} from '../shared/ids.js';
import {parseArchiveConversation} from './archive.js';
import type {Session, StoredConversation} from './types.js';

function mapped(ids: ReadonlyMap<string, string>, id: string): string {
  const value = ids.get(id);
  if (value === undefined) throw new Error('会话导入包含无效的关联 ID');
  return value;
}

export function insertImportedConversation(database: DatabaseSync, profileName: string, input: StoredConversation): Session {
  if (!profileName.trim() || profileName.length > 256) throw new Error('导入目标配置名称无效');
  const conversation = parseArchiveConversation(input);
  const timestamp = now();
  const session: Session = {...conversation.session, id: createId(), profileName, updatedAt: timestamp, latestPlanMessageId: null};
  const messageIds = new Map(conversation.messages.map(message => [message.id, createId()]));
  const runIds = new Map(conversation.agentRuns.map(run => [run.id, createId()]));
  database.prepare('INSERT INTO sessions(id,profile_name,title,created_at,updated_at,agent_mode) VALUES(?,?,?,?,?,?)')
    .run(session.id, profileName, session.title, session.createdAt, timestamp, session.agentMode);
  const insertMessage = database.prepare(`INSERT INTO messages(id,session_id,role,content,display_content,thinking,status,error_code,error_message,input_tokens,output_tokens,credits,provider_state,agent_run_id,iteration,created_at,updated_at,attachments_json) VALUES(?,?,?,?,?,'',?,?,?,?,?,?,NULL,?,?,?,?,?)`);
  for (const message of conversation.messages) {
    insertMessage.run(mapped(messageIds, message.id), session.id, message.role, message.content, message.displayContent ?? null,
      message.status === 'streaming' ? 'failed' : message.status,
      message.status === 'streaming' ? 'stream_interrupted' : message.errorCode,
      message.status === 'streaming' ? '导入的未完成消息不会自动执行' : message.errorMessage,
      message.usage?.inputTokens ?? null, message.usage?.outputTokens ?? null, message.usage?.credits ?? null,
      message.agentRunId ? mapped(runIds, message.agentRunId) : null, message.iteration ?? null,
      message.createdAt, message.updatedAt, JSON.stringify(message.attachments ?? []));
  }
  const insertRun = database.prepare(`INSERT INTO agent_runs(id,session_id,user_message_id,mode,status,stop_reason,iteration_count,input_tokens,output_tokens,credits,started_at,finished_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const run of conversation.agentRuns) {
    const wasRunning = run.status === 'running';
    insertRun.run(mapped(runIds, run.id), session.id, mapped(messageIds, run.userMessageId), run.mode,
      wasRunning || run.status === 'interrupted' ? 'stopped' : run.status,
      wasRunning ? 'process_interrupted' : run.stopReason, run.iterationCount, run.inputTokens, run.outputTokens,
      run.credits, run.startedAt, run.finishedAt ?? timestamp, run.updatedAt);
  }
  const insertCall = database.prepare(`INSERT INTO tool_calls(id,session_id,assistant_message_id,provider_call_id,position,tool_name,arguments_json,arguments_text,agent_run_id,approval_status,execution_status,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const call of conversation.toolCalls) {
    const incomplete = call.approvalStatus === 'pending' || call.executionStatus === 'queued' || call.executionStatus === 'running';
    const result = incomplete ? {status: 'interrupted', error: {code: 'interrupted', message: '导入的未完成工具不会执行', retryable: false}} : call.result;
    insertCall.run(createId(), session.id, mapped(messageIds, call.assistantMessageId), call.providerCallId, call.position,
      call.toolName, JSON.stringify(call.arguments), call.argumentsText ?? JSON.stringify(call.arguments),
      call.agentRunId ? mapped(runIds, call.agentRunId) : null,
      call.approvalStatus === 'pending' ? 'denied' : call.approvalStatus,
      incomplete ? 'interrupted' : call.executionStatus, result === null ? null : JSON.stringify(result), call.createdAt, call.updatedAt);
  }
  if (conversation.session.latestPlanMessageId !== null) {
    session.latestPlanMessageId = mapped(messageIds, conversation.session.latestPlanMessageId);
    database.prepare('UPDATE sessions SET latest_plan_message_id=? WHERE id=?').run(session.latestPlanMessageId, session.id);
  }
  return session;
}
