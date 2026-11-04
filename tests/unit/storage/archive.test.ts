import {chmod, mkdtemp, readFile, rm, stat, truncate, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {createSessionArchive, parseArchiveConversation, parseSessionArchive, readSessionArchive, writeSessionArchive} from '../../../src/storage/archive.js';
import type {StoredConversation} from '../../../src/storage/types.js';

const directories: string[] = [];
const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, {recursive: true, force: true})));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'bitori-session-archive-'));
  directories.push(path);
  return path;
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`缺少测试数据项 ${index}`);
  return value;
}

function fixture(): StoredConversation {
  return {
    session: {
      id: 'session-1', profileName: 'source', title: 'Portable session', createdAt: 100, updatedAt: 200,
      agentMode: 'execute', latestPlanMessageId: null,
    },
    messages: [
      {
        id: 'message-user', sessionId: 'session-1', role: 'user', content: 'What is in this picture?',
        attachments: [{name: 'pixel.png', mediaType: 'image/png', data: tinyPng}], displayContent: 'What is in this picture?',
        thinking: '', status: 'completed', errorCode: null, errorMessage: null, usage: null, providerState: null,
        agentRunId: 'run-1', iteration: null, createdAt: 100, updatedAt: 100,
      },
      {
        id: 'message-assistant', sessionId: 'session-1', role: 'assistant', content: 'It is a tiny image.',
        displayContent: 'It is a tiny image.', thinking: 'private reasoning', status: 'completed', errorCode: null,
        errorMessage: null, usage: {inputTokens: 10, outputTokens: 4},
        providerState: {protocol: 'anthropic', payload: [{type: 'thinking', thinking: 'signed private state', signature: 'private-signature'}]},
        agentRunId: 'run-1', iteration: 1, createdAt: 150, updatedAt: 200,
      },
    ],
    toolCalls: [{
      id: 'tool-1', sessionId: 'session-1', assistantMessageId: 'message-assistant', providerCallId: 'provider-call-1',
      position: 0, toolName: 'read_file', arguments: {path: 'notes.txt'}, argumentsText: '{"path":"notes.txt"}',
      agentRunId: 'run-1', approvalStatus: 'not_required', executionStatus: 'succeeded',
      result: {status: 'success', output: {content: 'visible tool output'}}, createdAt: 160, updatedAt: 170,
    }],
    agentRuns: [{
      id: 'run-1', sessionId: 'session-1', userMessageId: 'message-user', mode: 'execute', status: 'completed',
      stopReason: 'natural_completion', iterationCount: 1, inputTokens: 10, outputTokens: 4, credits: null,
      startedAt: 100, finishedAt: 200, updatedAt: 200,
    }],
    checkpoint: {boundaryMessageId: 'message-user', items: []},
  };
}

describe('session archive', () => {
  it('round-trips the portable allowlist, visible content, tools, runs, and embedded images', () => {
    const source = fixture();
    Object.assign(source.session, {apiKey: 'never-portable'});
    const archive = createSessionArchive(source);
    const serialized: unknown = JSON.parse(JSON.stringify(archive));
    const parsed = parseSessionArchive(serialized);

    expect(archive).toMatchObject({format: 'bitori-session', version: 1});
    expect(Object.keys(archive.conversation)).toEqual(['session', 'messages', 'toolCalls', 'agentRuns']);
    expect(at(archive.conversation.messages, 1)).toMatchObject({thinking: '', providerState: null, content: 'It is a tiny image.'});
    expect(archive.conversation.messages[0]?.attachments).toEqual([{name: 'pixel.png', mediaType: 'image/png', data: tinyPng}]);
    expect(parsed).toEqual(archive.conversation);
    expect(parseArchiveConversation(archive.conversation)).toEqual(archive.conversation);
    expect(archive.conversation).not.toHaveProperty('checkpoint');
    expect(JSON.stringify(archive)).not.toContain('never-portable');
    expect(JSON.stringify(archive)).not.toContain('apiKey');
    expect(JSON.stringify(archive)).not.toContain('private-signature');
    expect(JSON.stringify(archive)).not.toContain('private reasoning');
  });

  it('reads and writes a bounded JSON archive without replacing an existing file', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'conversation.json');
    const conversation = fixture();
    await writeSessionArchive(path, conversation);
    const loaded = await readSessionArchive(path);
    expect(loaded).toEqual(createSessionArchive(conversation).conversation);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);

    if (process.platform !== 'win32') await chmod(path, 0o644);
    await expect(writeSessionArchive(path, conversation)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toContain('bitori-session');
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o644);
  });

  it('rejects unsupported versions, cross-session references, and duplicate IDs', () => {
    const archive = createSessionArchive(fixture());
    expect(() => parseSessionArchive({...archive, version: 2})).toThrow();

    const crossSession = structuredClone(archive);
    at(crossSession.conversation.messages, 0).sessionId = 'another-session';
    expect(() => parseSessionArchive(crossSession)).toThrow();

    const duplicateId = structuredClone(archive);
    at(duplicateId.conversation.toolCalls, 0).id = 'run-1';
    expect(() => parseSessionArchive(duplicateId)).toThrow();
  });

  it('rejects hidden fields, nonempty provider state, and image paths in RPC payloads', () => {
    const archive = createSessionArchive(fixture());
    const withCredential = structuredClone(archive);
    Object.assign(withCredential.conversation.session, {apiKey: 'do-not-export'});
    expect(() => parseSessionArchive(withCredential)).toThrow();

    const withThinking: unknown = {
      ...structuredClone(archive.conversation),
      messages: archive.conversation.messages.map((message, index) => index === 1 ? {...message, thinking: 'secret reasoning'} : message),
    };
    expect(() => parseArchiveConversation(withThinking)).toThrow();

    const withProviderStateAgain = structuredClone(archive.conversation);
    Object.assign(at(withProviderStateAgain.messages, 1), {providerState: {protocol: 'openai-responses', payload: [{signature: 'secret'}]}});
    expect(() => parseArchiveConversation(withProviderStateAgain)).toThrow();

    const withPath = structuredClone(archive.conversation);
    at(withPath.messages, 0).attachments = [{name: 'image.png', mediaType: 'image/png', data: '../private/image.png'}];
    expect(() => parseArchiveConversation(withPath)).toThrow();
  });

  it('rejects files larger than 16 MiB before parsing', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'oversized.json');
    await writeFile(path, '');
    await truncate(path, 16 * 1024 * 1024 + 1);
    await expect(readSessionArchive(path)).rejects.toThrow(/16 MiB/);
  });
});
