import {mkdtempSync, rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {SessionRepository} from '../../src/storage/repository.js';
import {createSessionArchive, parseSessionArchive} from '../../src/storage/archive.js';
import {createId} from '../../src/shared/ids.js';
import type {FinalMessageUpdate, ToolCallRecord} from '../../src/storage/types.js';

const roots: string[] = [];
const repositories: SessionRepository[] = [];
const png = {name: 'pixel.png', mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='} as const;
const update: FinalMessageUpdate = {content: '', thinking: '', status: 'completed', error: null, usage: null, providerState: null};

async function open(path?: string) {
  const root = path ?? mkdtempSync(join(tmpdir(), 'bitori-product-storage-'));
  if (!path) roots.push(root);
  const repository = new SessionRepository(join(root, 'db.sqlite'));
  repositories.push(repository);
  await repository.initialize();
  return {root, repository};
}

async function prepare(repository: SessionRepository, toolName: string, completed = true) {
  const session = await repository.createSession('source');
  const runId = createId();
  await repository.beginAgentRun({runId, sessionId: session.id, displayText: 'inspect this image', mode: 'execute', attachments: [png]});
  const assistant = await repository.beginAgentIteration({messageId: createId(), runId, sessionId: session.id, iteration: 1});
  const call: ToolCallRecord = {id: createId(), sessionId: session.id, assistantMessageId: assistant.id, providerCallId: 'provider-call', position: 0,
    toolName, arguments: {path: 'note.txt'}, agentRunId: runId, approvalStatus: completed ? 'approved' : 'pending',
    executionStatus: completed ? 'succeeded' : 'running', result: completed ? {status: 'success', output: {text: 'done'}} : null,
    createdAt: Date.now(), updatedAt: Date.now()};
  await repository.finalizeIterationWithToolBatch(assistant.id, update, [call]);
  await repository.checkpointAgentRun(runId, 2, {inputTokens: 100, outputTokens: 20});
  return {session, runId, call};
}

afterEach(async () => {
  for (const repository of repositories.splice(0)) await repository.close();
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});

describe('product persistence boundaries', () => {
  it('does not start another turn in a session that already has an active owner', async () => {
    const {repository} = await open();
    const {session} = await prepare(repository, 'read_file');
    await expect(repository.beginAgentRun({runId: createId(), sessionId: session.id, displayText: 'second', mode: 'execute'})).rejects.toThrow('运行中的任务');
    expect((await repository.getConversation(session.id))?.agentRuns).toHaveLength(1);
  });

  it('persists images and imports complete history with fresh IDs and no runnable imported turn', async () => {
    const {repository} = await open();
    const {session, runId, call} = await prepare(repository, 'read_file');
    const source = await repository.getConversation(session.id);
    if (!source) throw new Error('Missing source conversation');
    expect(source.messages[0]?.attachments).toEqual([png]);
    const imported = await repository.importConversation('target', parseSessionArchive(createSessionArchive(source)));
    const copy = await repository.getConversation(imported.id);
    if (!copy) throw new Error('Missing imported conversation');
    expect(imported.id).not.toBe(session.id);
    expect(imported.profileName).toBe('target');
    expect(copy.messages[0]?.attachments).toEqual([png]);
    expect(copy.messages.map(message => message.id).some(id => source.messages.some(message => message.id === id))).toBe(false);
    expect(copy.agentRuns[0]?.id).not.toBe(runId);
    expect(copy.agentRuns[0]?.status).toBe('stopped');
    expect(copy.toolCalls[0]?.id).not.toBe(call.id);
    expect(copy.toolCalls[0]?.result).toEqual(call.result);
    expect(copy.toolCalls[0]?.assistantMessageId).toBe(copy.messages[1]?.id);
    const importedRun = copy.agentRuns[0];
    if (!importedRun) throw new Error('Missing imported run');
    expect(await repository.claimInterruptedRun(importedRun.id, true)).toBeNull();
  });

  it('rejects invalid import references without leaving an extra session', async () => {
    const {repository} = await open();
    const {session, call} = await prepare(repository, 'read_file');
    const source = await repository.getConversation(session.id);
    if (!source) throw new Error('Missing source conversation');
    const portable = parseSessionArchive(createSessionArchive(source));
    await expect(repository.importConversation('target', {...portable, toolCalls: [{...call, assistantMessageId: 'missing'}]})).rejects.toThrow('助手消息');
    expect(await repository.listSessions('target')).toEqual([]);
  });

  it('rolls back an import if a database write fails after creating the new session', async () => {
    const {root, repository} = await open();
    const {session} = await prepare(repository, 'read_file');
    const source = await repository.getConversation(session.id);
    if (!source) throw new Error('Missing source conversation');
    const database = new DatabaseSync(join(root, 'db.sqlite'));
    database.exec("CREATE TRIGGER fail_import_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'injected import failure'); END");
    try {
      await expect(repository.importConversation('target', parseSessionArchive(createSessionArchive(source)))).rejects.toThrow('injected import failure');
    } finally {
      database.close();
    }
    expect(await repository.listSessions('target')).toEqual([]);
  });

  it('claims an interrupted turn once, keeping completed tool results and monotonic budget checkpoints', async () => {
    const first = await open();
    const {session, runId, call} = await prepare(first.repository, 'read_file');
    await expect(first.repository.checkpointAgentRun(runId, 1, {inputTokens: 1, outputTokens: 1})).rejects.toThrow('预算倒退');
    await first.repository.close();
    const {repository} = await open(first.root);
    const resumed = await repository.claimInterruptedRun(runId);
    expect(resumed).toMatchObject({status: 'running', iterationCount: 2, inputTokens: 100, outputTokens: 20});
    expect(await repository.claimInterruptedRun(runId)).toBeNull();
    const conversation = await repository.getConversation(session.id);
    expect(conversation?.toolCalls[0]?.result).toEqual(call.result);
    expect(conversation?.toolCalls[0]?.executionStatus).toBe('succeeded');
  });

  it('keeps the last known credits when a later checkpoint omits them and rejects lower reported credits', async () => {
    const {repository} = await open();
    const {session, runId} = await prepare(repository, 'read_file');
    await repository.checkpointAgentRun(runId, 2, {inputTokens: 100, outputTokens: 20, credits: 10});
    await repository.checkpointAgentRun(runId, 2, {inputTokens: 100, outputTokens: 20});
    let conversation = await repository.getConversation(session.id);
    expect(conversation?.agentRuns[0]?.credits).toBe(10);
    await expect(repository.checkpointAgentRun(runId, 2, {inputTokens: 100, outputTokens: 20, credits: 9})).rejects.toThrow('预算倒退');
    conversation = await repository.getConversation(session.id);
    expect(conversation?.agentRuns[0]?.credits).toBe(10);
  });

  it('requires confirmation for uncertain command effects and leaves their result interrupted', async () => {
    const first = await open();
    const {session, runId} = await prepare(first.repository, 'run_command', false);
    await first.repository.close();
    const {repository} = await open(first.root);
    expect(await repository.claimInterruptedRun(runId)).toBeNull();
    expect((await repository.getConversation(session.id))?.toolCalls[0]?.executionStatus).toBe('interrupted');
    expect(await repository.claimInterruptedRun(runId, true)).toMatchObject({id: runId, status: 'running'});
    expect((await repository.getConversation(session.id))?.toolCalls[0]?.executionStatus).toBe('interrupted');
  });
});
