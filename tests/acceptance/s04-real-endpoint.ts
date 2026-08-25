import {mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../../src/config/loader.js';
import type {ProviderProfile} from '../../src/config/types.js';
import {createLLMClient} from '../../src/providers/factory.js';
import type {ChatRequest, LLMClient, StreamEvent, Usage} from '../../src/providers/types.js';
import {ChatController} from '../../src/chat/controller.js';
import {SessionRepository} from '../../src/storage/repository.js';
import {createToolSystem} from '../../src/tools/create-tool-system.js';

/** [s04] 真实端点验收驱动（checklist E2E-2/E2E-3）：包装真实客户端，记录每次请求、工具调用序列与全部 usage 事件。 */

interface RequestLog {index: number; toolCalls: string[]; finishReason: string | null; usages: Usage[]}

class RecordingClient implements LLMClient {
  readonly requests: ChatRequest[] = [];
  readonly logs: RequestLog[] = [];
  readonly #inner: LLMClient;
  constructor(inner: LLMClient) { this.#inner = inner; }

  async *streamChat(request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    const log: RequestLog = {index: this.requests.length - 1, toolCalls: [], finishReason: null, usages: []};
    this.logs.push(log);
    for await (const event of this.#inner.streamChat(request, signal)) {
      if (event.type === 'tool_call_start') log.toolCalls.push(event.name);
      else if (event.type === 'usage') log.usages.push(event.usage);
      else if (event.type === 'completed') log.finishReason = event.finishReason;
      yield event;
    }
  }
}

function usageText(usage: Usage): string {
  return `in=${usage.inputTokens} out=${usage.outputTokens} cacheCreate=${usage.cacheCreationInputTokens ?? '-'} cacheRead=${usage.cacheReadInputTokens ?? '-'}`;
}

function printLogs(client: RecordingClient, from = 0): void {
  for (const log of client.logs.slice(from)) {
    const tools = log.toolCalls.length > 0 ? ` tools=[${log.toolCalls.join(',')}]` : '';
    const usages = log.usages.map(usageText).join(' | ');
    console.log(`  [请求${log.index}] finish=${log.finishReason ?? '-'}${tools} ${usages}`);
  }
}

function reminderKind(request: ChatRequest): string {
  const last = request.items?.at(-1);
  if (last?.type !== 'reminder') return '无';
  return last.text.includes('只能使用只读工具进行探索和分析') ? '完整' : '精简';
}

async function makeController(profile: ProviderProfile, workspace: string): Promise<{client: RecordingClient; controller: ChatController}> {
  const client = new RecordingClient(createLLMClient(profile));
  const tools = createToolSystem(workspace);
  // [s04] 验收自动审批：写入类工具在一次性工作区内批准；命令一律拒绝，避免真实模型在本机执行 shell。
  tools.approvals.subscribe(prompt => { if (prompt) tools.approvals.resolve(prompt.callId, prompt.effect === 'command' ? 'denied' : 'approved'); });
  const controller = new ChatController(client, new SessionRepository(join(workspace, 'db.sqlite')), tools);
  await controller.initialize(profile);
  return {client, controller};
}

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'mycode-s04-accept-'));
  console.log(`工作区：${root}`);
  return root;
}

async function scenarioCache(profile: ProviderProfile): Promise<void> {
  console.log('\n===== E2E-2：真实缓存验证 =====');
  const {client, controller} = await makeController(profile, workspace());
  const prompts = ['用一句话介绍你自己。', '你刚才说了什么？也用一句话回答。', '我们现在对话到第几轮了？只回答数字。'];
  for (const [index, text] of prompts.entries()) {
    const before = client.logs.length;
    await controller.sendMessage(text);
    console.log(`第 ${index + 1} 轮（${text}）：`);
    printLogs(client, before);
    console.log(`  状态栏用量：${usageText(controller.getState().runUsage)}`);
  }
  const replies = controller.getState().messages.filter(message => message.role === 'assistant').map(message => message.content);
  console.log(`助手回复数：${replies.length}，末条回复：${replies.at(-1)?.slice(0, 80) ?? ''}`);
  await controller.shutdown();
}

async function scenarioS1(profile: ProviderProfile): Promise<void> {
  console.log('\n===== 场景一：读取后编辑 =====');
  const root = workspace();
  mkdirSync(join(root, 'notes'), {recursive: true});
  writeFileSync(join(root, 'notes', 'todo.md'), '- [ ] 买牛奶\n- [ ] 写周报\n- [ ] 还书\n', 'utf8');
  const {client, controller} = await makeController(profile, root);
  await controller.sendMessage('把 notes/todo.md 里的「买牛奶」改成「买燕麦奶」。');
  printLogs(client);
  const sequence = client.logs.flatMap(log => log.toolCalls);
  console.log(`工具调用序列：${sequence.join(' → ') || '（无工具调用）'}`);
  console.log(`编辑前已读取：${sequence.indexOf('read_file') !== -1 && sequence.indexOf('read_file') < sequence.indexOf('edit_file')}`);
  console.log(`文件结果：${readFileSync(join(root, 'notes', 'todo.md'), 'utf8').replaceAll('\n', ' / ')}`);
  await controller.shutdown();
}

async function scenarioS2(profile: ProviderProfile): Promise<void> {
  console.log('\n===== 场景二：专用工具优先 =====');
  const root = workspace();
  mkdirSync(join(root, 'src'), {recursive: true});
  writeFileSync(join(root, 'src', 'a.ts'), 'export const marker = "buildSystemPrompt";\n', 'utf8');
  writeFileSync(join(root, 'src', 'b.ts'), 'export const other = 1;\n', 'utf8');
  writeFileSync(join(root, 'src', 'c.txt'), 'nothing here\n', 'utf8');
  const {client, controller} = await makeController(profile, root);
  await controller.sendMessage('找出 src 目录下所有 .ts 文件，并告诉我哪个文件里出现了 buildSystemPrompt。');
  printLogs(client);
  const sequence = client.logs.flatMap(log => log.toolCalls);
  console.log(`工具调用序列：${sequence.join(' → ') || '（无工具调用）'}`);
  console.log(`是否使用 run_command：${sequence.includes('run_command')}`);
  const reply = controller.getState().messages.filter(message => message.role === 'assistant').at(-1)?.content ?? '';
  console.log(`回复摘要：${reply.slice(0, 120)}`);
  await controller.shutdown();
}

async function scenarioS3(profile: ProviderProfile): Promise<void> {
  console.log('\n===== 场景三：Plan 模式只读约束与提醒节奏 =====');
  const root = workspace();
  writeFileSync(join(root, 'README.md'), '# demo\n一个演示项目。\n', 'utf8');
  const {client, controller} = await makeController(profile, root);
  await controller.sendMessage('/plan');
  await controller.sendMessage('给我制定一个为项目添加 README 徽章的计划。');
  console.log('Plan 第 1 轮：');
  printLogs(client);
  const before2 = client.logs.length;
  await controller.sendMessage('把计划再细化一下实施步骤。');
  console.log('Plan 第 2 轮：');
  printLogs(client, before2);
  console.log(`各请求末尾提醒：${client.requests.map(request => reminderKind(request)).join(' / ')}`);
  const planTools = client.logs.flatMap(log => log.toolCalls);
  console.log(`Plan 阶段工具：${planTools.join(' → ') || '（未用工具）'}；越权工具：${planTools.some(name => !['read_file', 'find_files', 'search_text'].includes(name))}`);
  console.log(`界面消息含 system-reminder：${controller.getState().messages.some(message => message.content.includes('<system-reminder>'))}`);
  const beforeDo = client.logs.length;
  await controller.sendMessage('/do');
  console.log('/do 执行：');
  printLogs(client, beforeDo);
  const doRequest = client.requests[beforeDo];
  console.log(`/do 请求携带提醒：${doRequest?.items?.some(item => item.type === 'reminder') ?? false}；/do 请求工具数：${doRequest?.tools?.length ?? 0}`);
  console.log(`README 结果：${readFileSync(join(root, 'README.md'), 'utf8').replaceAll('\n', ' / ').slice(0, 160)}`);
  await controller.shutdown();
}

async function scenarioS4(profile: ProviderProfile): Promise<void> {
  console.log('\n===== 场景四：输出风格 =====');
  const {controller} = await makeController(profile, workspace());
  await controller.sendMessage('解释一下 TypeScript 的 unknown 和 any 的区别，并给个例子。');
  const reply = controller.getState().messages.filter(message => message.role === 'assistant').at(-1)?.content ?? '';
  console.log(`回复全文：\n${reply}`);
  await controller.shutdown();
}

const scenario = process.argv[2] ?? 'cache';
const profile = loadConfig().profiles.find(item => item.name === 'deepseek-v4-flash');
if (!profile) throw new Error('配置中找不到 deepseek-v4-flash profile');
console.log(`profile：${profile.name}（${profile.protocol}，${profile.baseUrl}）`);

if (scenario === 'cache') await scenarioCache(profile);
else if (scenario === 's1') await scenarioS1(profile);
else if (scenario === 's2') await scenarioS2(profile);
else if (scenario === 's3') await scenarioS3(profile);
else if (scenario === 's4') await scenarioS4(profile);
else throw new Error(`未知场景：${scenario}`);
