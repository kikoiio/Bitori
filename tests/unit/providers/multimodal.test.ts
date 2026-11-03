import {describe, expect, it, vi} from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import {AgentContext} from '../../../src/agent/context.js';
import {manageContext} from '../../../src/compact/compact.js';
import type {ProviderProfile} from '../../../src/config/types.js';
import {imageAttachmentFromBytes} from '../../../src/attachments/images.js';
import {AnthropicClient} from '../../../src/providers/anthropic.js';
import {OpenAIChatClient} from '../../../src/providers/openai-chat.js';
import {OpenAIResponsesClient} from '../../../src/providers/openai-responses.js';
import {QoderClient} from '../../../src/providers/qoder.js';
import type {LLMClient, ModelContextItem, ModelMessageItem, StreamEvent} from '../../../src/providers/types.js';
import {estimateContextTokens, serializedItem} from '../../../src/shared/token-estimate.js';

const image = imageAttachmentFromBytes(Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00,
  0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]), 'one.gif');
const item: ModelMessageItem = {type: 'message', messageId: 'user-1', role: 'user', content: 'What is in this picture?', attachments: [image]};
const anthropicProfile: ProviderProfile = {name: 'anthropic', protocol: 'anthropic', model: 'm', baseUrl: 'https://x', apiKey: 'k', thinking: {type: 'disabled'}};
const chatProfile: ProviderProfile = {name: 'chat', protocol: 'openai-chat', model: 'm', baseUrl: 'https://x', apiKey: 'k', thinking: {type: 'disabled'}};
const responsesProfile: ProviderProfile = {name: 'responses', protocol: 'openai-responses', model: 'm', baseUrl: 'https://x', apiKey: 'k', thinking: {type: 'disabled'}};
const qoderProfile: ProviderProfile = {name: 'qoder', protocol: 'qoder', model: 'm', baseUrl: 'https://x', apiKey: 'k', thinking: {type: 'disabled'}};

async function collect(client: LLMClient, request: Parameters<LLMClient['streamChat']>[0]): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of client.streamChat(request, new AbortController().signal)) events.push(event);
  return events;
}

function expectImageError(events: readonly StreamEvent[], expectedMessage: string): void {
  const error = events.find(event => event.type === 'error');
  expect(error?.type).toBe('error');
  if (error?.type !== 'error') throw new Error('缺少图片 Provider 错误');
  expect(error.error.code).toBe('invalid_request');
  expect(error.error.message).toContain(expectedMessage);
}

async function* emptyChatStream() { yield {choices: []}; }
async function* emptyResponsesStream() { yield {type: 'response.completed', response: {status: 'completed', output: []}}; }
function anthropicStream() {
  return Object.assign((async function* () {})(), {finalMessage: async () => ({content: []})});
}

describe('图片多模态 provider 契约', () => {
  it('Anthropic 将 base64 附件编码为 image source block', async () => {
    const stream = vi.fn().mockReturnValue(anthropicStream());
    const sdk = {messages: {stream}} as unknown as Anthropic;
    await collect(new AnthropicClient(anthropicProfile, sdk), {messages: [], items: [item]});

    expect(stream.mock.calls[0]?.[0]).toMatchObject({messages: [{
      role: 'user',
      content: [
        {type: 'text', text: item.content},
        {type: 'image', source: {type: 'base64', media_type: 'image/gif', data: image.data}},
      ],
    }]});
  });

  it('Anthropic 400 拒绝图片时提示切换视觉模型且不去掉图片重发', async () => {
    const stream = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('model does not support images'), {status: 400});
    });
    const sdk = {messages: {stream}} as unknown as Anthropic;
    const events = await collect(new AnthropicClient(anthropicProfile, sdk), {messages: [], items: [item]});

    expect(stream).toHaveBeenCalledTimes(1);
    expectImageError(events, '请改用支持视觉输入的模型，或移除图片附件');
  });

  it('Chat Completions 将附件编码为 image_url data URL', async () => {
    const create = vi.fn().mockResolvedValue(emptyChatStream());
    const sdk = {chat: {completions: {create}}} as unknown as OpenAI;
    await collect(new OpenAIChatClient(chatProfile, sdk), {messages: [], items: [item]});

    const sent = (create.mock.calls[0]?.[0] as {messages: Array<{role: string; content: unknown}>}).messages;
    expect(sent).toEqual([{
      role: 'user',
      content: [
        {type: 'text', text: item.content},
        {type: 'image_url', image_url: {url: `data:image/gif;base64,${image.data}`, detail: 'auto'}},
      ],
    }]);
  });

  it('兼容 ChatMessage 旧式请求时同样发送图片', async () => {
    const create = vi.fn().mockResolvedValue(emptyChatStream());
    const sdk = {chat: {completions: {create}}} as unknown as OpenAI;
    await collect(new OpenAIChatClient(chatProfile, sdk), {messages: [{role: 'user', content: 'legacy', attachments: [image]}]});

    const sent = (create.mock.calls[0]?.[0] as {messages: Array<{content: unknown}>}).messages;
    expect(sent[0]?.content).toEqual([
      {type: 'text', text: 'legacy'},
      {type: 'image_url', image_url: {url: `data:image/gif;base64,${image.data}`, detail: 'auto'}},
    ]);
  });

  it('Chat Completions 模型不支持图片时给出可操作错误且不重发文本', async () => {
    const create = vi.fn().mockRejectedValue(Object.assign(new Error('model does not support images'), {status: 400}));
    const sdk = {chat: {completions: {create}}} as unknown as OpenAI;
    const events = await collect(new OpenAIChatClient(chatProfile, sdk), {messages: [], items: [item]});

    expect(create).toHaveBeenCalledTimes(1);
    expectImageError(events, '请改用支持视觉输入的模型，或移除图片附件');
  });

  it('Responses 将附件编码为 input_image', async () => {
    const create = vi.fn().mockResolvedValue(emptyResponsesStream());
    const sdk = {responses: {create}} as unknown as OpenAI;
    await collect(new OpenAIResponsesClient(responsesProfile, sdk), {messages: [], items: [item]});

    const input = (create.mock.calls[0]?.[0] as {input: unknown[]}).input;
    expect(input).toEqual([{
      role: 'user',
      content: [
        {type: 'input_text', text: item.content},
        {type: 'input_image', image_url: `data:image/gif;base64,${image.data}`},
      ],
    }]);
  });

  it('Responses 模型不支持图片时给出可操作错误且不重发文本', async () => {
    const create = vi.fn().mockRejectedValue(Object.assign(new Error('model does not support images'), {status: 400}));
    const sdk = {responses: {create}} as unknown as OpenAI;
    const events = await collect(new OpenAIResponsesClient(responsesProfile, sdk), {messages: [], items: [item]});

    expect(create).toHaveBeenCalledTimes(1);
    expectImageError(events, '请改用支持视觉输入的模型，或移除图片附件');
  });

  it('Qoder 在联网前明确拒绝图片请求', async () => {
    let fetched = false;
    const fetcher: typeof fetch = async () => {
      fetched = true;
      throw new Error('unexpected network request');
    };
    const events = await collect(new QoderClient(qoderProfile, fetcher), {messages: [], items: [item]});

    expect(fetched).toBe(false);
    expectImageError(events, 'Qoder 不支持图片附件');
  });

  it('从已存用户消息恢复附件，并按图像 token 预算而非 base64 长度估算', () => {
    const storedMessage = {
      id: item.messageId, sessionId: 'session-1', role: 'user' as const, content: item.content,
      thinking: '', status: 'completed' as const, errorCode: null, errorMessage: null, usage: null,
      providerState: null, attachments: [image], createdAt: 1, updatedAt: 1,
    };
    const conversation = {
      session: {id: 'session-1', profileName: 'test', title: 'test', createdAt: 1, updatedAt: 1, agentMode: 'execute' as const, latestPlanMessageId: null},
      messages: [storedMessage], toolCalls: [], agentRuns: [],
    };
    const restored = AgentContext.fromConversation(conversation).items()[0];
    expect(restored).toMatchObject({type: 'message', attachments: [image]});

    const plain: ModelContextItem = {type: 'message', messageId: 'plain', role: 'user', content: item.content};
    expect(serializedItem(item)).not.toContain(image.data);
    expect(estimateContextTokens([item], null) - estimateContextTokens([plain], null)).toBe(1024);
  });

  it('压缩时把最早的带图消息留在原始上下文尾部', async () => {
    const items: ModelContextItem[] = Array.from({length: 12}, (_, index): ModelContextItem => ({
      type: 'message', messageId: `message-${index}`, role: 'user', content: 'text'.repeat(2_500),
      ...(index === 2 ? {attachments: [image]} : {}),
    }));
    const client: LLMClient = {
      async *streamChat() {
        yield {type: 'text_delta', text: '<summary>summary</summary>'};
        yield {type: 'completed', finishReason: 'stop'};
      },
    };
    const result = await manageContext({
      items, client, contextWindow: 1, tracking: {consecutiveFailures: 0}, tools: [], anchor: null,
      signal: new AbortController().signal,
    }, {force: true});

    expect(result.compacted).toBe(true);
    if (!result.compacted) return;
    expect(result.keepIndex).toBe(2);
    expect(result.items).toContainEqual(items[2]);
    expect(JSON.stringify(result.items)).toContain(image.data);
  });
});
