import {parentPort, workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {createId, now} from '../shared/ids.js';
import {getLogger} from '../shared/logger.js';
import {isProviderState} from '../providers/types.js';
import {runMigrations} from './migrations/index.js';
import type {MigrationDatabase} from './migrations/index.js';
import {serializeWorkerError} from './worker-client.js';
import type {StorageOperation, StorageRequest, StorageResponse} from './worker-protocol.js';
import type {AgentRunRecord, BeginTurnResult, FinalMessageUpdate, Session, StoredMessage, ToolCallRecord} from './types.js';

const logger = getLogger('storage');

// Worker 入口收到数据库路径；下面两个 Row 接口保留 SQLite 的 snake_case 列名。
interface WorkerData {databasePath: string}
interface SessionRow {id: string; profile_name: string; title: string; created_at: number; updated_at: number; agent_mode: Session['agentMode']; latest_plan_message_id: string | null}
interface MessageRow {
  id: string; session_id: string; role: 'user' | 'assistant'; content: string; thinking: string;
  status: 'streaming' | 'completed' | 'cancelled' | 'failed'; error_code: StoredMessage['errorCode'];
  error_message: string | null; input_tokens: number | null; output_tokens: number | null;
  provider_state: string | null; agent_run_id: string | null; iteration: number | null; created_at: number; updated_at: number;
}
interface ToolCallRow {id: string; session_id: string; assistant_message_id: string; provider_call_id: string | null; position: number; tool_name: string; arguments_json: string; arguments_text: string | null; agent_run_id: string | null; approval_status: ToolCallRecord['approvalStatus']; execution_status: ToolCallRecord['executionStatus']; result_json: string | null; created_at: number; updated_at: number}
interface AgentRunRow {id: string; session_id: string; user_message_id: string; mode: AgentRunRecord['mode']; status: AgentRunRecord['status']; stop_reason: AgentRunRecord['stopReason']; iteration_count: number; input_tokens: number; output_tokens: number; started_at: number; finished_at: number | null; updated_at: number}

if (parentPort === null) throw new Error('Storage Worker 必须在线程中运行');
const port = parentPort;
const data = workerData as WorkerData;
const database = new DatabaseSync(data.databasePath);
// WAL 提升读写并发；外键保证关联；FULL 提升落盘可靠性；busy_timeout 避免短暂锁冲突立即失败。
database.exec('PRAGMA journal_mode = WAL');
database.exec('PRAGMA foreign_keys = ON');
database.exec('PRAGMA synchronous = FULL');
database.exec('PRAGMA busy_timeout = 5000');
let closed = false;
const ownerId = createId();

/** 执行同步事务，并保证回调抛错时回滚。SQLite 被隔离在线程中，所以同步 API 不会卡住 TUI 主线程。 */
function transaction<T>(callback: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/** 把数据库行的 snake_case 字段转换成应用层 camelCase 对象。 */
function session(row: SessionRow): Session {
  return {id: row.id, profileName: row.profile_name, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at, agentMode: row.agent_mode, latestPlanMessageId: row.latest_plan_message_id};
}

function agentRun(row: AgentRunRow): AgentRunRecord { return {id: row.id, sessionId: row.session_id, userMessageId: row.user_message_id, mode: row.mode, status: row.status, stopReason: row.stop_reason, iterationCount: row.iteration_count, inputTokens: row.input_tokens, outputTokens: row.output_tokens, startedAt: row.started_at, finishedAt: row.finished_at, updatedAt: row.updated_at}; }

function message(row: MessageRow): StoredMessage {
  let providerState: StoredMessage['providerState'] = null;
  if (row.provider_state !== null) {
    try {
      const parsed: unknown = JSON.parse(row.provider_state);
      if (isProviderState(parsed)) providerState = parsed;
    } catch (error) {
      // 损坏的可重放状态安全降级为普通文本。
      // 降级发生时记录日志，便于发现持久化数据异常。
      logger.debug('provider_state 反序列化失败，已降级为普通文本', {error: error instanceof Error ? error.message : String(error)});
    }
  }
  const usage = row.input_tokens === null || row.output_tokens === null
    ? null : {inputTokens: row.input_tokens, outputTokens: row.output_tokens};
  return {
    id: row.id, sessionId: row.session_id, role: row.role, content: row.content, thinking: row.thinking,
    status: row.status, errorCode: row.error_code, errorMessage: row.error_message, usage, providerState, agentRunId: row.agent_run_id, iteration: row.iteration,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function toolCall(row: ToolCallRow): ToolCallRecord { return {id: row.id, sessionId: row.session_id, assistantMessageId: row.assistant_message_id, providerCallId: row.provider_call_id, position: row.position, toolName: row.tool_name, arguments: JSON.parse(row.arguments_json) as ToolCallRecord['arguments'], argumentsText: row.arguments_text ?? row.arguments_json, agentRunId: row.agent_run_id, approvalStatus: row.approval_status, executionStatus: row.execution_status, result: row.result_json === null ? null : JSON.parse(row.result_json) as ToolCallRecord['result'], createdAt: row.created_at, updatedAt: row.updated_at}; }

function finalizeMessage(messageId: string, update: FinalMessageUpdate): void {
  database.prepare(`UPDATE messages SET content = ?, thinking = ?, status = ?, error_code = ?, error_message = ?,
    input_tokens = ?, output_tokens = ?, provider_state = ?, updated_at = ? WHERE id = ?`)
    .run(update.content, update.thinking, update.status, update.error?.code ?? null, update.error?.message ?? null,
      update.usage?.inputTokens ?? null, update.usage?.outputTokens ?? null,
      update.providerState === null ? null : JSON.stringify(update.providerState), now(), messageId);
}

function insertToolBatch(records: ToolCallRecord[]): void {
  const insert = database.prepare(`INSERT INTO tool_calls(id,session_id,assistant_message_id,provider_call_id,position,tool_name,arguments_json,arguments_text,agent_run_id,approval_status,execution_status,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const record of records) insert.run(record.id, record.sessionId, record.assistantMessageId, record.providerCallId, record.position, record.toolName, JSON.stringify(record.arguments), record.argumentsText ?? JSON.stringify(record.arguments), record.agentRunId ?? null, record.approvalStatus, record.executionStatus, record.result === null ? null : JSON.stringify(record.result), record.createdAt, record.updatedAt);
}


function interruptRun(runId: string): void {
  transaction(() => {
    const timestamp = now();
    database.prepare(`UPDATE messages SET status='failed', error_code='stream_interrupted', error_message='程序中断，Agent 未自动续跑', updated_at=? WHERE agent_run_id=? AND status='streaming'`).run(timestamp, runId);
    database.prepare(`UPDATE tool_calls SET approval_status=CASE WHEN approval_status='pending' THEN 'denied' ELSE approval_status END, execution_status='interrupted', result_json=?, updated_at=? WHERE agent_run_id=? AND (execution_status IN ('queued','running') OR approval_status='pending')`).run(JSON.stringify({status: 'interrupted', error: {code: 'interrupted', message: '程序中断，工具未自动重试', retryable: false}}), timestamp, runId);
    database.prepare(`UPDATE agent_runs SET status='interrupted', stop_reason='process_interrupted', finished_at=?, updated_at=? WHERE id=? AND status='running'`).run(timestamp, timestamp, runId);
  });
}

function interruptLegacyMessage(messageId: string): void {
  transaction(() => {
    const timestamp = now();
    database.prepare(`UPDATE tool_calls SET approval_status=CASE WHEN approval_status='pending' THEN 'denied' ELSE approval_status END, execution_status='interrupted', result_json=?, updated_at=? WHERE assistant_message_id=? AND agent_run_id IS NULL AND (execution_status IN ('queued','running') OR approval_status='pending')`).run(JSON.stringify({status:'interrupted', error:{code:'interrupted',message:'程序中断，工具未自动重试',retryable:false}}), timestamp, messageId);
    database.prepare(`UPDATE messages SET status='failed',error_code='stream_interrupted',error_message='程序中断，Agent 未自动续跑',updated_at=? WHERE id=? AND status='streaming'`).run(timestamp, messageId);
  });
}

function processIsDead(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error instanceof Error && 'code' in error && error.code === 'ESRCH'; }
}

function recoverDeadOwners(): void {
  const runs = database.prepare(`SELECT id, owner_pid FROM agent_runs WHERE status='running' AND owner_pid IS NOT NULL`).all() as unknown as Array<{id: string; owner_pid: number}>;
  for (const run of runs) if (processIsDead(run.owner_pid)) interruptRun(run.id);
  const messages = database.prepare(`SELECT id, owner_pid FROM messages WHERE status='streaming' AND agent_run_id IS NULL AND owner_pid IS NOT NULL`).all() as unknown as Array<{id: string; owner_pid: number}>;
  for (const message of messages) if (processIsDead(message.owner_pid)) interruptLegacyMessage(message.id);
}

function execute(operation: StorageOperation): unknown {
  if (closed && operation.type !== 'close') throw new Error('存储已经关闭');
  switch (operation.type) {
    case 'initialize':
      runMigrations(database as unknown as MigrationDatabase);
      if (operation.recover !== false) recoverDeadOwners();
      return null;
    case 'find_latest_session': {
      const row = database.prepare('SELECT * FROM sessions WHERE profile_name = ? ORDER BY updated_at DESC LIMIT 1').get(operation.profileName) as SessionRow | undefined;
      return row === undefined ? null : session(row);
    }
    case 'list_sessions':
      return (database.prepare('SELECT * FROM sessions WHERE profile_name = ? ORDER BY updated_at DESC').all(operation.profileName) as unknown as SessionRow[]).map(session);
    case 'create_session': {
      const timestamp = now();
      const value: Session = {id: createId(), profileName: operation.profileName, title: '新会话', createdAt: timestamp, updatedAt: timestamp, agentMode: 'execute', latestPlanMessageId: null};
      database.prepare('INSERT INTO sessions(id, profile_name, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(value.id, value.profileName, value.title, value.createdAt, value.updatedAt);
      return value;
    }
    case 'get_session': {
      const row = database.prepare('SELECT * FROM sessions WHERE id = ?').get(operation.sessionId) as SessionRow | undefined;
      return row === undefined ? null : session(row);
    }
    case 'get_messages':
      return (database.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC').all(operation.sessionId) as unknown as MessageRow[]).map(message);
    case 'get_conversation': { const row = database.prepare('SELECT * FROM sessions WHERE id = ?').get(operation.sessionId) as SessionRow | undefined; if (!row) return null; const messages = (database.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC').all(operation.sessionId) as unknown as MessageRow[]).map(message); const toolCalls = (database.prepare('SELECT * FROM tool_calls WHERE session_id = ? ORDER BY assistant_message_id, position').all(operation.sessionId) as unknown as ToolCallRow[]).map(toolCall); const agentRuns = (database.prepare('SELECT * FROM agent_runs WHERE session_id = ? ORDER BY started_at ASC').all(operation.sessionId) as unknown as AgentRunRow[]).map(agentRun); const checkpointRow = database.prepare('SELECT boundary_message_id, items_json FROM context_checkpoints WHERE session_id=?').get(operation.sessionId) as {boundary_message_id: string; items_json: string} | undefined; const checkpoint = checkpointRow ? {boundaryMessageId: checkpointRow.boundary_message_id, items: JSON.parse(checkpointRow.items_json)} : null; return {session: session(row), messages, toolCalls, agentRuns, checkpoint}; }
    case 'save_context_checkpoint': transaction(() => {
      const boundary = database.prepare('SELECT rowid FROM messages WHERE id=? AND session_id=?').get(operation.checkpoint.boundaryMessageId, operation.sessionId) as {rowid: number} | undefined;
      if (!boundary) throw new Error('压缩检查点边界不存在');
      const previous = database.prepare('SELECT m.rowid FROM context_checkpoints c JOIN messages m ON m.id=c.boundary_message_id WHERE c.session_id=?').get(operation.sessionId) as {rowid: number} | undefined;
      if (previous && previous.rowid > boundary.rowid) throw new Error('压缩检查点已被更新');
      database.prepare('INSERT INTO context_checkpoints(session_id,boundary_message_id,items_json) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET boundary_message_id=excluded.boundary_message_id,items_json=excluded.items_json').run(operation.sessionId, operation.checkpoint.boundaryMessageId, JSON.stringify(operation.checkpoint.items));
    }); return null;
    case 'save_tool_batch': transaction(() => insertToolBatch(operation.records)); return null;
    case 'finalize_assistant_with_tool_batch': transaction(() => { finalizeMessage(operation.messageId, operation.update); insertToolBatch(operation.records); }); return null;
    case 'update_tool_call': { const record = operation.record; database.prepare(`UPDATE tool_calls SET approval_status=?, execution_status=?, result_json=?, updated_at=? WHERE id=?`).run(record.approvalStatus, record.executionStatus, record.result === null ? null : JSON.stringify(record.result), record.updatedAt, record.id); return null; }
    case 'begin_turn': {
      // user 消息和空的 assistant 草稿必须原子创建，不能留下“半个对话轮次”。
      const begin = (): BeginTurnResult => transaction(() => {
        const timestamp = now();
        const userId = createId();
        const assistantId = createId();
        const count = (database.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get(operation.sessionId) as {count: number}).count;
        const insert = database.prepare(`INSERT INTO messages(
          id, session_id, role, content, thinking, status, error_code, error_message,
          input_tokens, output_tokens, provider_state, created_at, updated_at, owner_id, owner_pid
        ) VALUES (?, ?, ?, ?, '', ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`);
        insert.run(userId, operation.sessionId, 'user', operation.text, 'completed', timestamp, timestamp, ownerId, process.pid);
        // +1 保证同一毫秒创建的 assistant 在 user 之后排序。
        insert.run(assistantId, operation.sessionId, 'assistant', '', 'streaming', timestamp + 1, timestamp + 1, ownerId, process.pid);
        const title = operation.text.trim().replace(/\s+/g, ' ').slice(0, 60) || '新会话';
        // 只有会话首轮用用户输入生成标题，以后发送消息只更新时间。
        database.prepare(`UPDATE sessions SET updated_at = ?, title = CASE WHEN ? = 0 THEN ? ELSE title END WHERE id = ?`)
          .run(timestamp, count, title, operation.sessionId);
        const userRow = database.prepare('SELECT * FROM messages WHERE id = ?').get(userId) as unknown as MessageRow;
        const assistantRow = database.prepare('SELECT * FROM messages WHERE id = ?').get(assistantId) as unknown as MessageRow;
        return {userMessage: message(userRow), assistantMessage: message(assistantRow)};
      });
      return begin();
    }
    case 'begin_assistant_continuation': {
      const timestamp = now();
      const id = createId();
      database.prepare(`INSERT INTO messages(id, session_id, role, content, thinking, status, error_code, error_message, input_tokens, output_tokens, provider_state, created_at, updated_at, owner_id, owner_pid) VALUES (?, ?, 'assistant', '', '', 'streaming', NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`)
        .run(id, operation.sessionId, timestamp, timestamp, ownerId, process.pid);
      return message(database.prepare('SELECT * FROM messages WHERE id = ?').get(id) as unknown as MessageRow);
    }
    case 'checkpoint_assistant':
      // 流式过程中只更新仍处于 streaming 的草稿，终态消息不会被迟到的 checkpoint 覆盖。
      database.prepare(`UPDATE messages SET content = ?, thinking = ?, updated_at = ? WHERE id = ? AND status = 'streaming'`)
        .run(operation.content, operation.thinking, now(), operation.messageId);
      return null;
    case 'finalize_message': {
      finalizeMessage(operation.messageId, operation.update);
      return null;
    }
    case 'set_session_mode': {
      database.prepare('UPDATE sessions SET agent_mode=?, updated_at=? WHERE id=?').run(operation.mode, now(), operation.sessionId);
      const row = database.prepare('SELECT * FROM sessions WHERE id=?').get(operation.sessionId) as SessionRow | undefined;
      if (!row) throw new Error('会话不存在');
      return session(row);
    }
    case 'begin_agent_run': return transaction(() => {
      const current = database.prepare('SELECT * FROM sessions WHERE id=?').get(operation.sessionId) as SessionRow | undefined;
      if (!current) throw new Error('会话不存在');
      const timestamp = now(); const userId = createId();
      const count = (database.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id=?').get(operation.sessionId) as {count: number}).count;
      database.prepare(`INSERT INTO messages(id,session_id,role,content,thinking,status,error_code,error_message,input_tokens,output_tokens,provider_state,agent_run_id,iteration,created_at,updated_at,owner_id,owner_pid) VALUES(?,?, 'user',?,'','completed',NULL,NULL,NULL,NULL,NULL,?,NULL,?,?,?,?)`).run(userId, operation.sessionId, operation.displayText, operation.runId, timestamp, timestamp, ownerId, process.pid);
      database.prepare(`INSERT INTO agent_runs(id,session_id,user_message_id,mode,status,stop_reason,iteration_count,input_tokens,output_tokens,started_at,finished_at,updated_at,owner_id,owner_pid) VALUES(?,?,?,?,'running',NULL,0,0,0,?,NULL,?,?,?)`).run(operation.runId, operation.sessionId, userId, operation.mode, timestamp, timestamp, ownerId, process.pid);
      const title = operation.displayText.trim().replace(/\s+/g, ' ').slice(0, 60) || '新会话';
      database.prepare(`UPDATE sessions SET updated_at=?, title=CASE WHEN ?=0 THEN ? ELSE title END WHERE id=?`).run(timestamp, count, title, operation.sessionId);
      return {run: agentRun(database.prepare('SELECT * FROM agent_runs WHERE id=?').get(operation.runId) as unknown as AgentRunRow), userMessage: message(database.prepare('SELECT * FROM messages WHERE id=?').get(userId) as unknown as MessageRow)};
    });
    case 'begin_agent_iteration': {
      const timestamp = now();
      database.prepare(`INSERT INTO messages(id,session_id,role,content,thinking,status,error_code,error_message,input_tokens,output_tokens,provider_state,agent_run_id,iteration,created_at,updated_at,owner_id,owner_pid) VALUES(?,?,'assistant','','','streaming',NULL,NULL,NULL,NULL,NULL,?,?,?, ?,?,?)`).run(operation.messageId, operation.sessionId, operation.runId, operation.iteration, timestamp, timestamp, ownerId, process.pid);
      return message(database.prepare('SELECT * FROM messages WHERE id=?').get(operation.messageId) as unknown as MessageRow);
    }
    case 'finalize_iteration_with_tool_batch': transaction(() => { finalizeMessage(operation.messageId, operation.update); insertToolBatch(operation.records); }); return null;
    case 'abort_agent_run': transaction(() => {
      const timestamp = now();
      const running = database.prepare("SELECT id FROM agent_runs WHERE id=? AND status='running'").get(operation.runId);
      if (!running) return;
      database.prepare(`UPDATE messages SET status=?,error_code=?,error_message=?,updated_at=? WHERE agent_run_id=? AND status='streaming'`).run(operation.result.status === 'cancelled' ? 'cancelled' : 'failed', 'stream_interrupted', operation.message, timestamp, operation.runId);
      database.prepare(`UPDATE tool_calls SET approval_status=CASE WHEN approval_status='pending' THEN 'denied' ELSE approval_status END,execution_status='interrupted',result_json=?,updated_at=? WHERE agent_run_id=? AND (execution_status IN ('queued','running') OR approval_status='pending')`).run(JSON.stringify({status:'interrupted',error:{code:'interrupted',message:operation.message,retryable:false}}), timestamp, operation.runId);
      database.prepare(`UPDATE agent_runs SET status=?,stop_reason=?,iteration_count=?,input_tokens=?,output_tokens=?,finished_at=?,updated_at=? WHERE id=? AND status='running'`).run(operation.result.status, operation.result.stopReason, operation.result.iterationCount, operation.result.usage.inputTokens, operation.result.usage.outputTokens, timestamp, timestamp, operation.runId);
    }); return null;
    case 'finish_agent_run': transaction(() => {
      const timestamp = now();
      database.prepare(`UPDATE agent_runs SET status=?,stop_reason=?,iteration_count=?,input_tokens=?,output_tokens=?,finished_at=?,updated_at=? WHERE id=?`).run(operation.result.status, operation.result.stopReason, operation.result.iterationCount, operation.result.usage.inputTokens, operation.result.usage.outputTokens, timestamp, timestamp, operation.runId);
      if (operation.latestPlanMessageId !== undefined) database.prepare(`UPDATE sessions SET latest_plan_message_id=?,updated_at=? WHERE id=(SELECT session_id FROM agent_runs WHERE id=?)`).run(operation.latestPlanMessageId, timestamp, operation.runId);
    }); return null;
    case 'close':
      if (!closed) {
        const owned = database.prepare(`SELECT id FROM agent_runs WHERE status='running' AND owner_id=?`).all(ownerId) as unknown as Array<{id: string}>;
        for (const run of owned) interruptRun(run.id);
        const legacy = database.prepare(`SELECT id FROM messages WHERE status='streaming' AND agent_run_id IS NULL AND owner_id=?`).all(ownerId) as unknown as Array<{id: string}>;
        for (const row of legacy) interruptLegacyMessage(row.id);
        database.close();
        closed = true;
      }
      return null;
    default: return assertNever(operation);
  }
}

function assertNever(value: never): never { throw new Error(`未知存储操作：${JSON.stringify(value)}`); }

// Worker 是一个小型 RPC 服务：接收命令，执行同步 SQLite 操作，再按 requestId 回传结果。
port.on('message', (request: StorageRequest) => {
  let response: StorageResponse;
  try {
    response = {requestId: request.requestId, result: execute(request.operation)};
  } catch (error) {
    response = {requestId: request.requestId, error: serializeWorkerError(error)};
  }
  port.postMessage(response);
  // close 响应先发回主线程，再关闭 MessagePort，让客户端的 close Promise 能正常完成。
  if (request.operation.type === 'close') port.close();
});
