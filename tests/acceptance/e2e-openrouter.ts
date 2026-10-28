import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../../src/config/loader.js';
import type {ProviderProfile} from '../../src/config/types.js';
import {createLLMClient} from '../../src/providers/factory.js';
import type {ChatRequest, LLMClient, StreamEvent} from '../../src/providers/types.js';
import {ChatController} from '../../src/chat/agent-controller.js';
import {SessionRepository} from '../../src/storage/repository.js';
import {createToolSystem} from '../../src/tools/create-tool-system.js';

/** OpenAI 兼容真实端点 E2E：走完整 AgentRunner 链路，验证流式、工具调用与结果回传。 */

const retryDelayMs = 20_000;
const baseUrl = process.env.LLM_BASE_URL ?? 'https://openrouter.ai/api/v1';

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

class RecordingClient implements LLMClient {
  readonly requests: ChatRequest[] = [];
  readonly toolCalls: string[] = [];
  #streamErrors = 0;
  readonly #inner: LLMClient;

  constructor(inner: LLMClient) { this.#inner = inner; }

  async *streamChat(request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    let attempt = 0;
    while (true) {
      let failed = false;
    for await (const event of this.#inner.streamChat(request, signal)) {
      if (event.type === 'tool_call_start') this.toolCalls.push(event.name);
      else if (event.type === 'error' && event.error.retryable) { failed = true; break; }
      yield event;
    }
      if (!failed || signal.aborted || ++attempt >= 3) return;
      this.#streamErrors++;
      console.log(`模型流失败，${retryDelayMs / 1000} 秒后重试（第 ${attempt + 1} 次）`);
      await sleep(retryDelayMs);
    }
  }

  get streamErrors(): number { return this.#streamErrors; }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`E2E 断言失败：${message}`);
}

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'bitori-openrouter-e2e-'));
  mkdirSync(join(root, 'notes'), {recursive: true});
  writeFileSync(join(root, 'notes', 'todo.md'), '- [ ] 买牛奶\n- [ ] 写周报\n', 'utf8');
  // bypass 让 edit 在无人值守 CI 中可执行；单独 deny run_command 防止模型执行 shell。
  mkdirSync(join(root, '.bitori'), {recursive: true});
  writeFileSync(join(root, '.bitori', 'permissions.local.yaml'), 'mode: bypass\nrules:\n  - tool: run_command\n    pattern: "*"\n    decision: deny\n', 'utf8');
  return root;
}

async function run(profile: ProviderProfile, root: string): Promise<void> {
  const inner = createLLMClient(profile);
  const client = new RecordingClient(inner);
  const tools = createToolSystem(root, {}, {clientFor: () => inner, memoryClient: inner});
  const controller = new ChatController(client, new SessionRepository(join(root, 'db.sqlite')), tools);
  try {
    await controller.initialize(profile);
    await controller.sendMessage('把 notes/todo.md 里的「买牛奶」改成「买燕麦奶」。完成后用一句话确认。');
    const state = controller.getState();
    const reply = [...state.messages].findLast(message => message.role === 'assistant')?.content ?? '';
    const failed = [...state.messages].findLast(message => message.role === 'assistant' && message.status === 'failed');
    const content = readFileSync(join(root, 'notes', 'todo.md'), 'utf8');

    console.log(`模型请求次数：${client.requests.length}`);
    console.log(`工具调用序列：${client.toolCalls.join(' → ') || '（无）'}`);
    console.log(`流级重试次数：${client.streamErrors}`);
    console.log(`停止原因：${state.stopReason ?? '（无）'}；失败信息：${failed?.errorMessage ?? '（无）'}`);
    console.log(`最终回复：${reply.slice(0, 300)}`);
    console.log(`文件结果：${content.replaceAll('\n', ' / ')}`);
    assert(client.toolCalls.includes('read_file'), '必须先调用 read_file 读取文件');
    assert(client.toolCalls.includes('edit_file'), '必须调用 edit_file 完成修改');
    assert(client.toolCalls.indexOf('read_file') < client.toolCalls.indexOf('edit_file'), 'read_file 必须发生在 edit_file 之前');
    assert(!client.toolCalls.includes('run_command'), '该任务不得使用 run_command');
    assert(content.includes('买燕麦奶') && !content.includes('买牛奶'), 'todo.md 必须被正确修改');
    assert(reply.trim().length > 0, '助手必须给出非空最终回复');
    assert(state.visibleError === null, `控制器不应报错：${state.visibleError ?? ''}`);
  } finally {
    await controller.shutdown();
    await tools.close();
    rmSync(root, {recursive: true, force: true});
  }
}

const model = process.env.LLM_MODEL;
if (!model) throw new Error('缺少 LLM_MODEL 环境变量');
if (model === '__list__') {
  const response = await fetch(`${baseUrl}/models`, {headers: {Authorization: `Bearer ${process.env.LLM_API_KEY ?? ''}`}});
  const body = await response.json() as {data?: Array<{id?: string; context_window?: number}>};
  if (!response.ok) throw new Error(`模型列表请求失败：${response.status} ${JSON.stringify(body)}`);
  for (const item of body.data ?? []) console.log(`${item.id ?? ''}\t${item.context_window ?? ''}`);
  process.exit(0);
}
const root = workspace();
const configDirectory = join(root, 'home');
mkdirSync(join(configDirectory, '.bitori'), {recursive: true});
writeFileSync(join(configDirectory, '.bitori', 'config.yaml'), [
  'profiles:',
  '  - name: openrouter-e2e',
  '    protocol: openai-chat',
  `    model: "${model}"`,
  `    base_url: "${baseUrl}"`,
  '    api_key: "${LLM_API_KEY}"',
  '    context_window: 262144',
  '',
].join('\n'), 'utf8');
writeFileSync(join(configDirectory, '.bitori', '.env'), `LLM_API_KEY=${process.env.LLM_API_KEY ?? ''}\n`, 'utf8');

const profile = loadConfig(configDirectory, root).profiles[0]!;
console.log(`profile：${profile.name}（${profile.protocol}，${profile.model}）`);
await run(profile, root);
console.log('真实端点 E2E 全部通过');
