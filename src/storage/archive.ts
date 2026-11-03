import {randomUUID} from 'node:crypto';
import {open, link, unlink} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import {z} from 'zod';
import {imageAttachmentsSchema} from '../attachments/images.js';
import type {ToolError, ToolExecutionResult} from '../tools/types.js';
import type {Usage} from '../providers/types.js';
import type {StoredConversation} from './types.js';

const FORMAT = 'bitori-session';
const VERSION = 1;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_NODES = 500_000;
const MAX_MESSAGES = 10_000;
const MAX_TOOL_CALLS = 15_000;
const MAX_AGENT_RUNS = 5_000;
const MAX_TEXT_CHARACTERS = 2_000_000;
const MAX_ERROR_CHARACTERS = 16_000;
const MAX_JSON_DEPTH = 48;

const idSchema = z.string().min(1).max(256);
const nonnegativeIntegerSchema = z.number().int().nonnegative();
const finiteNonnegativeSchema = z.number().finite().nonnegative();

/** Walk values iteratively so hostile nesting cannot exhaust the JS call stack. */
function assertSafeTree(value: unknown, allowUndefined: boolean): void {
  const active = new WeakSet<object>();
  const stack: Array<{value: unknown; depth: number; leave?: object}> = [{value, depth: 0}];
  let nodes = 0;
  let stringBytes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    if (current.leave !== undefined) {
      active.delete(current.leave);
      continue;
    }
    nodes += 1;
    if (nodes > MAX_ARCHIVE_NODES) throw new Error('会话归档包含过多数据项');
    if (current.depth > MAX_JSON_DEPTH) throw new Error('会话归档嵌套层级过深');

    const item = current.value;
    if (item === undefined && allowUndefined) continue;
    if (item === null || typeof item === 'boolean') continue;
    if (typeof item === 'string') {
      stringBytes += Buffer.byteLength(item, 'utf8');
      if (stringBytes > MAX_ARCHIVE_BYTES) throw new Error('会话归档超过 16 MiB');
      continue;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('会话归档含非有限数字');
      continue;
    }
    if (typeof item !== 'object') throw new Error('会话归档必须只包含 JSON 数据');

    const prototype = Reflect.getPrototypeOf(item);
    if ((!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) || (Array.isArray(item) && prototype !== Array.prototype)) {
      throw new Error('会话归档包含非 JSON 对象');
    }
    if (active.has(item)) throw new Error('会话归档不能包含循环引用');
    active.add(item);
    stack.push({value: null, depth: current.depth, leave: item});

    const descriptors = Object.getOwnPropertyDescriptors(item);
    const ownKeys = Reflect.ownKeys(item);
    if (ownKeys.some(key => typeof key !== 'string')) throw new Error('会话归档包含非 JSON 属性');
    const entries: Array<readonly [string, unknown]> = [];
    if (Array.isArray(item)) {
      if (item.length > MAX_TOOL_CALLS) throw new Error('会话归档数组条目过多');
      for (let index = 0; index < item.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new Error('会话归档包含稀疏数组或访问器');
        entries.push([String(index), descriptor.value]);
      }
      if (ownKeys.length !== item.length + 1) throw new Error('会话归档数组包含额外属性');
    } else {
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('会话归档包含非 JSON 属性');
        entries.push([key, descriptor.value]);
      }
      if (entries.length > MAX_TOOL_CALLS) throw new Error('会话归档对象字段过多');
    }
    for (const [key, child] of entries) {
      stringBytes += Buffer.byteLength(key, 'utf8');
      if (stringBytes > MAX_ARCHIVE_BYTES) throw new Error('会话归档超过 16 MiB');
      stack.push({value: child, depth: current.depth + 1});
    }
  }
}

const jsonValueSchema = z.unknown().superRefine((value, context) => {
  try {
    assertSafeTree(value, false);
  } catch (error) {
    context.addIssue({code: 'custom', message: error instanceof Error ? error.message : '无效 JSON 值'});
  }
});

const jsonObjectSchema = z.record(z.string().max(1_024), jsonValueSchema).superRefine((value, context) => {
  if (Object.keys(value).length > MAX_TOOL_CALLS) context.addIssue({code: 'custom', message: 'JSON 对象字段过多'});
});

const usageSchema = z.strictObject({
  inputTokens: nonnegativeIntegerSchema,
  outputTokens: nonnegativeIntegerSchema,
  cacheReadInputTokens: nonnegativeIntegerSchema.optional(),
  cacheCreationInputTokens: nonnegativeIntegerSchema.optional(),
  credits: finiteNonnegativeSchema.optional(),
});

const sessionSchema = z.strictObject({
  id: idSchema,
  profileName: z.string().min(1).max(128),
  title: z.string().max(2_000),
  createdAt: nonnegativeIntegerSchema,
  updatedAt: nonnegativeIntegerSchema,
  agentMode: z.enum(['plan', 'execute']),
  latestPlanMessageId: idSchema.nullable(),
});

const messageSchema = z.strictObject({
  id: idSchema,
  sessionId: idSchema,
  role: z.enum(['user', 'assistant']),
  content: z.string().max(MAX_TEXT_CHARACTERS),
  attachments: imageAttachmentsSchema.optional(),
  displayContent: z.string().max(MAX_TEXT_CHARACTERS).optional(),
  // Archives intentionally contain visible text only; provider signatures and thinking are never portable.
  thinking: z.literal(''),
  status: z.enum(['streaming', 'completed', 'cancelled', 'failed']),
  errorCode: z.enum([
    'authentication', 'rate_limit', 'network', 'context_limit', 'invalid_request', 'provider_error',
    'session_busy', 'model_not_found', 'unsupported_action', 'protocol_mismatch', 'unknown',
  ]).nullable(),
  errorMessage: z.string().max(MAX_ERROR_CHARACTERS).nullable(),
  usage: usageSchema.nullable(),
  providerState: z.null(),
  agentRunId: idSchema.nullable().optional(),
  iteration: nonnegativeIntegerSchema.nullable().optional(),
  createdAt: nonnegativeIntegerSchema,
  updatedAt: nonnegativeIntegerSchema,
});

const truncationSchema = z.strictObject({
  truncated: z.boolean(),
  originalUnits: nonnegativeIntegerSchema,
  returnedUnits: nonnegativeIntegerSchema,
  unit: z.enum(['bytes', 'matches']),
}).superRefine((value, context) => {
  if (value.returnedUnits > value.originalUnits) context.addIssue({code: 'custom', message: '截断结果不能超过原始长度'});
});

const toolErrorSchema = z.strictObject({
  code: z.enum([
    'invalid_arguments', 'unknown_tool', 'tool_unavailable_in_mode', 'path_outside_workspace', 'path_not_found',
    'path_already_exists', 'not_a_file', 'binary_file', 'invalid_utf8', 'permission_denied', 'no_unique_match',
    'command_failed', 'timeout', 'denied', 'interrupted', 'agent_loop_limit', 'hook_rejected', 'mcp_error', 'internal_error',
  ]),
  message: z.string().max(MAX_ERROR_CHARACTERS),
  retryable: z.boolean(),
  details: jsonObjectSchema.optional(),
});

const toolExecutionResultSchema = z.discriminatedUnion('status', [
  z.strictObject({status: z.literal('success'), output: jsonObjectSchema, truncation: truncationSchema.optional()}),
  z.strictObject({status: z.literal('error'), error: toolErrorSchema, partialOutput: jsonObjectSchema.optional(), truncation: truncationSchema.optional()}),
  z.strictObject({status: z.enum(['denied', 'timeout', 'interrupted']), error: toolErrorSchema, partialOutput: jsonObjectSchema.optional(), truncation: truncationSchema.optional()}),
]);

const toolCallSchema = z.strictObject({
  id: idSchema,
  sessionId: idSchema,
  assistantMessageId: idSchema,
  providerCallId: z.string().max(4_096).nullable(),
  position: nonnegativeIntegerSchema,
  toolName: z.string().min(1).max(256),
  arguments: jsonObjectSchema,
  argumentsText: z.string().max(MAX_TEXT_CHARACTERS).optional(),
  agentRunId: idSchema.nullable().optional(),
  approvalStatus: z.enum(['not_required', 'pending', 'approved', 'denied']),
  executionStatus: z.enum(['queued', 'running', 'succeeded', 'failed', 'timed_out', 'skipped', 'interrupted']),
  result: toolExecutionResultSchema.nullable(),
  createdAt: nonnegativeIntegerSchema,
  updatedAt: nonnegativeIntegerSchema,
});

const agentRunSchema = z.strictObject({
  id: idSchema,
  sessionId: idSchema,
  userMessageId: idSchema,
  mode: z.enum(['plan', 'execute']),
  status: z.enum(['running', 'completed', 'stopped', 'cancelled', 'failed', 'interrupted']),
  stopReason: z.enum([
    'natural_completion', 'iteration_limit', 'unknown_tool_limit', 'user_cancelled', 'stream_error', 'storage_error',
    'process_interrupted', 'context_compact_failed',
  ]).nullable(),
  iterationCount: nonnegativeIntegerSchema,
  inputTokens: nonnegativeIntegerSchema,
  outputTokens: nonnegativeIntegerSchema,
  credits: finiteNonnegativeSchema.nullable(),
  startedAt: nonnegativeIntegerSchema,
  finishedAt: nonnegativeIntegerSchema.nullable(),
  updatedAt: nonnegativeIntegerSchema,
}).superRefine((run, context) => {
  if (run.status === 'running' && (run.stopReason !== null || run.finishedAt !== null)) {
    context.addIssue({code: 'custom', message: '运行中的回合不能有停止原因或完成时间'});
  }
  if (run.status !== 'running' && (run.stopReason === null || run.finishedAt === null)) {
    context.addIssue({code: 'custom', message: '已结束的回合必须有停止原因和完成时间'});
  }
});

const conversationSchema = z.strictObject({
  session: sessionSchema,
  messages: z.array(messageSchema).max(MAX_MESSAGES),
  toolCalls: z.array(toolCallSchema).max(MAX_TOOL_CALLS),
  agentRuns: z.array(agentRunSchema).max(MAX_AGENT_RUNS),
}).superRefine((conversation, context) => {
  const issue = (path: Array<string | number>, message: string): void => context.addIssue({code: 'custom', path, message});
  const ids = new Set<string>();
  const registerId = (id: string, path: Array<string | number>): void => {
    if (ids.has(id)) issue(path, `重复 ID：${id}`);
    else ids.add(id);
  };
  const sessionId = conversation.session.id;
  registerId(sessionId, ['session', 'id']);

  const messagesById = new Map<string, typeof conversation.messages[number]>();
  for (const [index, message] of conversation.messages.entries()) {
    registerId(message.id, ['messages', index, 'id']);
    if (message.sessionId !== sessionId) issue(['messages', index, 'sessionId'], '消息必须属于归档中的会话');
    messagesById.set(message.id, message);
  }

  const runsById = new Map<string, typeof conversation.agentRuns[number]>();
  for (const [index, run] of conversation.agentRuns.entries()) {
    registerId(run.id, ['agentRuns', index, 'id']);
    if (run.sessionId !== sessionId) issue(['agentRuns', index, 'sessionId'], '回合必须属于归档中的会话');
    runsById.set(run.id, run);
  }

  for (const [index, message] of conversation.messages.entries()) {
    if (message.agentRunId != null && !runsById.has(message.agentRunId)) {
      issue(['messages', index, 'agentRunId'], '消息引用了不存在的回合');
    }
  }

  if (conversation.session.latestPlanMessageId !== null) {
    const planMessage = messagesById.get(conversation.session.latestPlanMessageId);
    if (planMessage === undefined || planMessage.role !== 'assistant') {
      issue(['session', 'latestPlanMessageId'], '最新计划必须引用本会话中的助手消息');
    }
  }

  for (const [index, run] of conversation.agentRuns.entries()) {
    const userMessage = messagesById.get(run.userMessageId);
    if (userMessage === undefined || userMessage.role !== 'user' || userMessage.agentRunId !== run.id) {
      issue(['agentRuns', index, 'userMessageId'], '回合必须引用关联到该回合的用户消息');
    }
  }

  const toolPositions = new Map<string, Set<number>>();
  for (const [index, call] of conversation.toolCalls.entries()) {
    registerId(call.id, ['toolCalls', index, 'id']);
    if (call.sessionId !== sessionId) issue(['toolCalls', index, 'sessionId'], '工具调用必须属于归档中的会话');
    const assistantMessage = messagesById.get(call.assistantMessageId);
    if (assistantMessage === undefined || assistantMessage.role !== 'assistant') {
      issue(['toolCalls', index, 'assistantMessageId'], '工具调用必须引用本会话中的助手消息');
    }
    if (call.agentRunId != null) {
      if (!runsById.has(call.agentRunId)) issue(['toolCalls', index, 'agentRunId'], '工具调用引用了不存在的回合');
      if (assistantMessage !== undefined && assistantMessage.agentRunId !== call.agentRunId) {
        issue(['toolCalls', index, 'agentRunId'], '工具调用和助手消息必须属于同一回合');
      }
    }
    const positions = toolPositions.get(call.assistantMessageId) ?? new Set<number>();
    if (positions.has(call.position)) issue(['toolCalls', index, 'position'], '同一助手消息中的工具调用位置不能重复');
    positions.add(call.position);
    toolPositions.set(call.assistantMessageId, positions);
  }
});

const archiveEnvelopeSchema = z.strictObject({
  format: z.literal(FORMAT),
  version: z.number().int().refine(value => value === VERSION, {message: `不支持的会话归档版本（当前仅支持 ${VERSION}）`}),
  conversation: z.unknown(),
});

type ArchivedConversation = z.infer<typeof conversationSchema>;

export interface SessionArchive {
  format: typeof FORMAT;
  version: typeof VERSION;
  conversation: ArchivedConversation;
}

function assertSerializedSize(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_ARCHIVE_BYTES) {
    throw new Error('会话归档超过 16 MiB');
  }
}

function normalizeUsage(usage: z.infer<typeof usageSchema> | null): Usage | null {
  if (usage === null) return null;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadInputTokens === undefined ? {} : {cacheReadInputTokens: usage.cacheReadInputTokens}),
    ...(usage.cacheCreationInputTokens === undefined ? {} : {cacheCreationInputTokens: usage.cacheCreationInputTokens}),
    ...(usage.credits === undefined ? {} : {credits: usage.credits}),
  };
}

function normalizeToolError(error: z.infer<typeof toolErrorSchema>): ToolError {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.details === undefined ? {} : {details: error.details}),
  };
}

function normalizeToolResult(result: z.infer<typeof toolExecutionResultSchema>): ToolExecutionResult {
  switch (result.status) {
    case 'success':
      return {status: result.status, output: result.output, ...(result.truncation === undefined ? {} : {truncation: result.truncation})};
    case 'error':
      return {
        status: result.status,
        error: normalizeToolError(result.error),
        ...(result.partialOutput === undefined ? {} : {partialOutput: result.partialOutput}),
        ...(result.truncation === undefined ? {} : {truncation: result.truncation}),
      };
    case 'denied':
    case 'timeout':
    case 'interrupted':
      return {
        status: result.status,
        error: normalizeToolError(result.error),
        ...(result.partialOutput === undefined ? {} : {partialOutput: result.partialOutput}),
        ...(result.truncation === undefined ? {} : {truncation: result.truncation}),
      };
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

function normalizeConversation(conversation: ArchivedConversation): StoredConversation {
  return {
    session: conversation.session,
    messages: conversation.messages.map(message => ({
      id: message.id,
      sessionId: message.sessionId,
      role: message.role,
      content: message.content,
      ...(message.attachments === undefined ? {} : {attachments: message.attachments}),
      ...(message.displayContent === undefined ? {} : {displayContent: message.displayContent}),
      thinking: message.thinking,
      status: message.status,
      errorCode: message.errorCode,
      errorMessage: message.errorMessage,
      usage: normalizeUsage(message.usage),
      providerState: null,
      ...(message.agentRunId === undefined ? {} : {agentRunId: message.agentRunId}),
      ...(message.iteration === undefined ? {} : {iteration: message.iteration}),
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    })),
    toolCalls: conversation.toolCalls.map(call => ({
      id: call.id,
      sessionId: call.sessionId,
      assistantMessageId: call.assistantMessageId,
      providerCallId: call.providerCallId,
      position: call.position,
      toolName: call.toolName,
      arguments: call.arguments,
      ...(call.argumentsText === undefined ? {} : {argumentsText: call.argumentsText}),
      ...(call.agentRunId === undefined ? {} : {agentRunId: call.agentRunId}),
      approvalStatus: call.approvalStatus,
      executionStatus: call.executionStatus,
      result: call.result === null ? null : normalizeToolResult(call.result),
      createdAt: call.createdAt,
      updatedAt: call.updatedAt,
    })),
    agentRuns: conversation.agentRuns.map(run => ({
      id: run.id,
      sessionId: run.sessionId,
      userMessageId: run.userMessageId,
      mode: run.mode,
      status: run.status,
      stopReason: run.stopReason,
      iterationCount: run.iterationCount,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      credits: run.credits,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      updatedAt: run.updatedAt,
    })),
  };
}

/** Validate a conversation at the storage RPC boundary; archives and workers share this parser. */
export function parseArchiveConversation(value: unknown): StoredConversation {
  assertSafeTree(value, true);
  const conversation = conversationSchema.parse(value);
  assertSerializedSize(conversation);
  return normalizeConversation(conversation);
}

/** Validate the versioned envelope, then reuse the same strict conversation validator as RPC imports. */
export function parseSessionArchive(value: unknown): StoredConversation {
  assertSafeTree(value, true);
  const envelope = archiveEnvelopeSchema.parse(value);
  const conversation = parseArchiveConversation(envelope.conversation);
  assertSerializedSize({format: envelope.format, version: envelope.version, conversation});
  return conversation;
}

/** Build a portable allowlist and remove provider replay material before serialization. */
export function createSessionArchive(conversation: StoredConversation): SessionArchive {
  if (conversation.messages.length > MAX_MESSAGES || conversation.toolCalls.length > MAX_TOOL_CALLS || conversation.agentRuns.length > MAX_AGENT_RUNS) {
    throw new Error('会话归档条目超过限制');
  }
  const portableConversation = {
    session: {
      id: conversation.session.id,
      profileName: conversation.session.profileName,
      title: conversation.session.title,
      createdAt: conversation.session.createdAt,
      updatedAt: conversation.session.updatedAt,
      agentMode: conversation.session.agentMode,
      latestPlanMessageId: conversation.session.latestPlanMessageId,
    },
    messages: conversation.messages.map(message => ({
      id: message.id,
      sessionId: message.sessionId,
      role: message.role,
      content: message.content,
      ...(message.attachments === undefined ? {} : {attachments: imageAttachmentsSchema.parse(message.attachments)}),
      ...(message.displayContent === undefined ? {} : {displayContent: message.displayContent}),
      thinking: '',
      status: message.status,
      errorCode: message.errorCode,
      errorMessage: message.errorMessage,
      usage: message.usage === null ? null : normalizeUsage(message.usage),
      providerState: null,
      ...(message.agentRunId === undefined ? {} : {agentRunId: message.agentRunId}),
      ...(message.iteration === undefined ? {} : {iteration: message.iteration}),
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    })),
    toolCalls: conversation.toolCalls.map(call => ({
      id: call.id,
      sessionId: call.sessionId,
      assistantMessageId: call.assistantMessageId,
      providerCallId: call.providerCallId,
      position: call.position,
      toolName: call.toolName,
      arguments: call.arguments,
      ...(call.argumentsText === undefined ? {} : {argumentsText: call.argumentsText}),
      ...(call.agentRunId === undefined ? {} : {agentRunId: call.agentRunId}),
      approvalStatus: call.approvalStatus,
      executionStatus: call.executionStatus,
      result: call.result === null ? null : normalizeToolResult(call.result),
      createdAt: call.createdAt,
      updatedAt: call.updatedAt,
    })),
    agentRuns: conversation.agentRuns.map(run => ({
      id: run.id,
      sessionId: run.sessionId,
      userMessageId: run.userMessageId,
      mode: run.mode,
      status: run.status,
      stopReason: run.stopReason,
      iterationCount: run.iterationCount,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      credits: run.credits,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      updatedAt: run.updatedAt,
    })),
  };
  const archive: SessionArchive = {
    format: FORMAT,
    version: VERSION,
    conversation: conversationSchema.parse(portableConversation),
  };
  assertSerializedSize(archive);
  return archive;
}

/** Read one bounded UTF-8 JSON file; image data is decoded only from embedded base64 fields. */
export async function readSessionArchive(path: string): Promise<StoredConversation> {
  const file = await open(path, 'r');
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error('会话归档路径必须指向普通文件');
    if (metadata.size > MAX_ARCHIVE_BYTES) throw new Error('会话归档超过 16 MiB');

    const chunks: Buffer[] = [];
    const chunk = Buffer.alloc(64 * 1024);
    let totalBytes = 0;
    while (true) {
      const {bytesRead} = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > MAX_ARCHIVE_BYTES) throw new Error('会话归档超过 16 MiB');
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    const text = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks, totalBytes));
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new Error('会话归档不是有效 JSON', {cause: error});
    }
    return parseSessionArchive(value);
  } finally {
    await file.close();
  }
}

/** Write atomically with exclusive creation, so an existing output is never replaced. */
export async function writeSessionArchive(path: string, conversation: StoredConversation): Promise<void> {
  const archive = createSessionArchive(conversation);
  const text = `${JSON.stringify(archive, null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > MAX_ARCHIVE_BYTES) throw new Error('会话归档超过 16 MiB');

  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const temporary = await open(temporaryPath, 'wx', 0o600);
  let closed = false;
  try {
    await temporary.writeFile(text, 'utf8');
    await temporary.sync();
    await temporary.close();
    closed = true;
    await link(temporaryPath, path);
  } finally {
    if (!closed) await temporary.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}
