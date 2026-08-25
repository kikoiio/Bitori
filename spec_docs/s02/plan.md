# MyCode 工具系统 Plan

## 架构概览

MyCode 在现有分层架构中新增独立工具域，并扩展 Provider、对话编排、存储和 TUI：

```text
CLI 启动层
  ├─ 捕获当前工作区根目录
  ├─ 创建六个工具与注册中心
  └─ 组装固定超时、结果上限和授权规则

Ink TUI
  ├─ 普通消息与工具记录展示
  └─ 逐项审批交互
       ↓
ChatController
  └─ TurnOrchestrator
       ├─ 统一 LLMClient
       │    ├─ Anthropic 协议适配
       │    ├─ OpenAI Responses 协议适配
       │    └─ OpenAI Chat 协议适配
       ├─ ToolCallAssembler
       ├─ ToolBatchCoordinator
       │    ├─ ApprovalCoordinator
       │    └─ ToolExecutor
       │         └─ ToolRegistry
       │              ├─ ReadFile
       │              ├─ WriteFile
       │              ├─ EditFile
       │              ├─ RunCommand
       │              ├─ FindFiles
       │              └─ SearchText
       └─ SessionRepository
            └─ Storage Worker / SQLite
```

### 工具域

工具域不依赖 Provider、TUI 或存储。每个工具通过统一接口声明名称、描述、JSON 参数约束、副作用类别和执行方法。`ToolRegistry` 是工具定义的唯一来源，拒绝重复名称、按名查找并为三个 Provider 提供同一集合。六个工具共享工作区路径验证、UTF-8 检测、结果截断和结构化错误设施。（F1–F9、F16–F18；N3、N5、N6、N8、N12）

### Provider 统一边界

`LLMClient` 同时支持统一工具描述、普通消息、模型工具调用、工具结果以及流式调用标识、名称和 JSON 参数片段。Anthropic、Responses 和 Chat 仅转换各自协议格式，不审批、不执行工具、不决定调度。（F1、F12、F14、F20、F21；N2、N12、N15）

### 流式调用组装

`ToolCallAssembler` 位于 Provider 边界之后，按稳定标识收集名称和参数片段并保留模型顺序。首轮流结束后输出完整调用和不可执行调用；完整 JSON 仍须经过注册工具的运行时参数校验，无效调用直接形成失败结果。（F12、F18、F21；N9、N14）

### 单回合编排

```text
用户消息 → 首次模型流 → 拼装首批工具调用 → 逐项审批与批次执行
        → 持久化整批结果 → 第二次模型流 → 最终文本回复 → 回合结束
```

第二次模型流中的新工具调用只保存为达到本阶段限制，不进入审批或执行。没有工具调用时沿用原有单次流式路径。（F13–F15、F18、F21；N9、N15）

### 审批与批次调度

`ApprovalCoordinator` 将创建、修改和命令调用逐项发布给 TUI。`ToolBatchCoordinator` 并行执行读取、查找和搜索，同时把创建、修改和命令按模型相对顺序逐项审批、串行执行。两类分支可同时推进；每项独立收敛，全部完成后才回灌。（F10、F11、F13、F16、F18；N4、N5、N7、N9）

### 工具执行环境

`ToolExecutor` 统一提供工作区、固定超时、固定结果上限、取消信号、截断和异常转换。文件工具严格验证真实路径；命令只固定启动目录，并在审批时明确其可能影响工作区外。（F9、F16–F18；N3–N10）

### 持久化

SQLite 使用独立工具调用记录关联会话和助手消息，保存稳定标识、顺序、参数、审批、执行结果和时间。恢复时将非终态调用标为 `interrupted`，不自动重试。上下文构造器按回合关系组合普通消息、调用与结果，再由 Provider 转换。（F20、F21；N9–N11、N14）

### TUI

聊天界面增加工具记录卡片和单项审批面板。审批状态属于应用状态；取消回合、关闭应用或异常收尾均由控制器统一终结未处理审批。（F6、F10、F11、F15、F19、F20；N4、N7、N11、N14）

## 核心数据结构

### 工具契约

```ts
type JsonObject = Record<string, unknown>;
type ToolEffect = 'read' | 'write' | 'command';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

interface ToolLimits {
  timeoutMs: number;
  maxResultBytes: number;
  maxMatches: number;
}

interface ToolContext {
  workspaceRoot: string;
  signal: AbortSignal;
  limits: ToolLimits;
}

interface Tool<TArgs extends JsonObject = JsonObject> {
  readonly name: string;
  readonly description: string;
  readonly effect: ToolEffect;
  readonly inputSchema: JsonObject;
  parseArguments(input: unknown): TArgs;
  execute(args: TArgs, context: ToolContext): Promise<ToolExecutionResult>;
}
```

`read` 自动执行；`write`、`command` 必须审批。JSON Schema 面向模型，`parseArguments` 对不可信模型输出做运行时校验。限制由应用注入，不属于模型参数。

### 六个工具参数

```ts
interface ReadFileArgs {path: string}
interface WriteFileArgs {path: string; content: string}
interface EditFileArgs {path: string; oldText: string; newText: string}
interface RunCommandArgs {command: string}
interface FindFilesArgs {pattern: string}
interface SearchTextArgs {query: string; filePattern?: string}
```

注册名称固定为 `read_file`、`write_file`、`edit_file`、`run_command`、`find_files`、`search_text`。路径相对工作区；文件模式使用 glob；搜索词按普通文本解释。参数中不提供工作目录、超时、结果上限、编码或审批选项。

### ToolRegistry

```ts
interface ToolRegistry {
  register(tool: Tool): void;
  get(name: string): Tool | undefined;
  definitions(): ToolDefinition[];
  entries(): Tool[];
}
```

重复名称在启动时报错，注册顺序稳定；未知名称转换为 `unknown_tool`。

### 工具调用

```ts
interface ToolCallDraft {
  internalId: string;
  providerCallId: string | null;
  position: number;
  name: string;
  argumentsText: string;
}

interface ToolCall {
  internalId: string;
  providerCallId: string;
  position: number;
  name: string;
  arguments: JsonObject;
  effect: ToolEffect;
}
```

`internalId` 由 MyCode 创建并贯穿 TUI、审批和存储；`providerCallId` 用于协议回灌；`position` 保存模型顺序。缺少合法标识、名称或参数的草稿仍保存失败记录。

### Provider 流事件

```ts
type StreamEvent =
  | {type: 'text_delta'; text: string}
  | {type: 'thinking_delta'; text: string}
  | {type: 'usage'; usage: Usage}
  | {type: 'tool_call_start'; internalId: string; providerCallId: string | null; position: number; name: string}
  | {type: 'tool_call_arguments_delta'; internalId: string; delta: string}
  | {type: 'tool_call_end'; internalId: string}
  | {type: 'completed'; finishReason: FinishReason; providerState?: ProviderState}
  | {type: 'error'; error: ProviderError};
```

`FinishReason` 增加 `tool_calls`。Provider 负责从内容块位置、output item 或 Chat index 映射稳定调用顺序和内部标识。

### ToolCallAssembler

```ts
interface InvalidToolCall {
  internalId: string;
  providerCallId: string | null;
  position: number;
  name: string;
  argumentsText: string;
  error: ToolError;
}

interface AssembledToolBatch {
  validCalls: ToolCall[];
  invalidCalls: InvalidToolCall[];
}

interface ToolCallAssembler {
  consume(event: StreamEvent): void;
  finish(registry: ToolRegistry): AssembledToolBatch;
}
```

`finish()` 检查事件完整性、拼接与解析 JSON、查找工具、校验参数，并按 `position` 排序。

### 审批

```ts
type ApprovalStatus = 'not_required' | 'pending' | 'approved' | 'denied';
type ToolExecutionStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'skipped' | 'interrupted';
type ApprovalDecision = 'approved' | 'denied';

interface ToolApprovalPrompt {
  callId: string;
  toolName: string;
  effect: 'write' | 'command';
  argumentSummary: string;
  riskMessage: string | null;
}

interface ApprovalCoordinator {
  request(call: ToolCall): Promise<ApprovalDecision>;
  resolve(callId: string, decision: ApprovalDecision): void;
  interruptAll(): void;
  getPendingPrompt(): ToolApprovalPrompt | null;
}
```

命令提示固定说明网络、子进程和工作区外风险；摘要不展示无限长正文。

### 结构化结果

```ts
type ToolErrorCode =
  | 'invalid_arguments' | 'unknown_tool'
  | 'path_outside_workspace' | 'path_not_found' | 'path_already_exists'
  | 'not_a_file' | 'binary_file' | 'invalid_utf8' | 'permission_denied'
  | 'no_unique_match' | 'command_failed' | 'timeout' | 'denied'
  | 'interrupted' | 'agent_loop_limit' | 'internal_error';

interface ToolError {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  details?: JsonObject;
}

interface TruncationInfo {
  truncated: boolean;
  originalUnits: number;
  returnedUnits: number;
  unit: 'bytes' | 'matches';
}

type ToolExecutionResult =
  | {status: 'success'; output: JsonObject; truncation?: TruncationInfo}
  | {status: 'error'; error: ToolError; partialOutput?: JsonObject; truncation?: TruncationInfo}
  | {status: 'denied' | 'timeout' | 'interrupted'; error: ToolError; partialOutput?: JsonObject; truncation?: TruncationInfo};
```

成功输出：

```ts
interface ReadFileOutput {path: string; content: string; sizeBytes: number}
interface WriteFileOutput {path: string; bytesWritten: number}
interface EditFileOutput {path: string; replacements: 1; bytesWritten: number}
interface RunCommandOutput {command: string; exitCode: number; stdout: string; stderr: string}
interface FindFilesOutput {pattern: string; paths: string[]; matchCount: number}
interface SearchTextOutput {
  query: string;
  matches: Array<{path: string; line: number; column: number; text: string}>;
  matchCount: number;
}
```

非零命令退出使用 `command_failed`，并通过 `partialOutput` 保留退出码和受限输出。

### 批次协调

```ts
interface ToolBatchResult {calls: ToolCallRecord[]}

interface ToolBatchContext {
  registry: ToolRegistry;
  executor: ToolExecutor;
  approvals: ApprovalCoordinator;
  repository: SessionRepositoryContract;
  assistantMessageId: string;
  signal: AbortSignal;
}

interface ToolBatchCoordinator {
  execute(batch: AssembledToolBatch, context: ToolBatchContext): Promise<ToolBatchResult>;
}
```

```text
Promise.allSettled(全部 read 调用)
          +
按 position 串行处理全部 write / command 调用
          ↓
等待两组收敛，再按 position 重组结果
```

### 模型上下文

```ts
interface MessageContextItem {
  type: 'message';
  role: 'user' | 'assistant';
  content: string;
  providerState?: ProviderState;
}

interface ToolCallContextItem {
  type: 'assistant_tool_calls';
  messageId: string;
  content: string;
  calls: ToolCallRecord[];
  providerState?: ProviderState;
}

interface ToolResultContextItem {
  type: 'tool_results';
  results: ToolCallRecord[];
}

type ChatContextItem = MessageContextItem | ToolCallContextItem | ToolResultContextItem;

interface ChatRequest {
  items: ChatContextItem[];
  tools: ToolDefinition[];
  phase: 'initial' | 'final';
}
```

`initial` 提供工具定义；`final` 保留工具历史但不提供可调用定义。兼容服务若仍返回调用，控制器硬性阻止。

### 持久化记录

```ts
interface ToolCallRecord {
  id: string;
  sessionId: string;
  assistantMessageId: string;
  providerCallId: string | null;
  position: number;
  toolName: string;
  argumentsText: string;
  arguments: JsonObject | null;
  effect: ToolEffect | null;
  approvalStatus: ApprovalStatus;
  executionStatus: ToolExecutionStatus;
  result: ToolExecutionResult | null;
  createdAt: number;
  updatedAt: number;
}

interface StoredConversation {
  messages: StoredMessage[];
  toolCalls: ToolCallRecord[];
}
```

仓储接口保留既有方法，并增加：

```ts
getConversation(sessionId: string): Promise<StoredConversation>;
finalizeInitialAssistantAndSaveToolBatch(
  messageId: string,
  update: FinalMessageUpdate,
  calls: ToolCallRecord[],
): Promise<void>;
updateToolApproval(callId: string, status: 'approved' | 'denied'): Promise<void>;
markToolRunning(callId: string): Promise<void>;
finishToolCall(callId: string, result: ToolExecutionResult): Promise<void>;
createAssistantContinuation(sessionId: string): Promise<StoredMessage>;
interruptUnfinishedToolCalls(): Promise<void>;
```

`finalizeInitialAssistantAndSaveToolBatch()` 在一个 SQLite 事务中终结首轮助手并创建完整批次，避免消息已完成但调用记录缺失。审批先于执行保存；结果独立提交；第二个助手草稿只在整批完成后创建；启动时中断遗留非终态调用。

### 应用状态

```ts
interface AppState {
  // 保留现有字段
  toolCalls: ToolCallRecord[];
  pendingApproval: ToolApprovalPrompt | null;
}

type RequestStatus =
  | 'idle' | 'thinking' | 'streaming' | 'awaiting_approval'
  | 'executing_tools' | 'cancelling' | 'failed';
```

`ChatController` 增加 `resolveToolApproval(callId, decision)`。`Ctrl+C` 在审批或执行期间取消整个回合：未决和未启动调用中断，活跃命令收到取消，已完成结果保留，不执行第二次回灌。

## 模块设计

### 工具契约与基础设施

- **工具契约模块**：定义工具、调用、审批、结果、错误和限制；仅依赖 TypeScript/Node 标准类型。
- **工具注册中心**：登记、去重、查找并输出稳定定义；只依赖工具契约。
- **工作区路径守卫**：保存真实根路径，拒绝绝对路径、空路径、穿越及链接逃逸；为已有文件、新文件和搜索根提供解析接口。
- **UTF-8 文本守卫**：严格解码，区分有效文本、无效 UTF-8 和二进制，不猜测编码。
- **结果限制模块**：按 UTF-8 字节限制文本、按数量限制匹配，保留原始与返回规模。

### 六个工具

- **ReadFile**：校验参数、解析已有文件、严格读取文本并截断。
- **WriteFile**：确认父目录存在且在工作区，排他创建，不自动建目录，失败清理残缺目标。
- **EditFile**：严格读取，统计字面匹配，仅一次时在同目录生成临时内容并安全替换。
- **RunCommand**：从工作区启动 PowerShell，限制并统计 stdout/stderr，取消或超时终止进程树。
- **FindFiles**：按 glob 查找普通文件，不越过链接边界，返回相对路径和截断规模。
- **SearchText**：按普通字符串搜索符合 glob 的 UTF-8 文件，返回一基行列，跳过二进制与不可读文件。

### 工具执行与编排

- **ToolExecutor**：查找工具、注入统一上下文、合并回合取消与固定超时，将异常归一化为一个终态结果。
- **ToolCallAssembler**：消费统一事件、拼接参数、检测标识/完整性问题并在流结束后校验。
- **ApprovalCoordinator**：一次暴露一个待审副作用调用，等待并验证决定，取消时中断全部未决审批。
- **ToolBatchCoordinator**：无效调用直接失败；只读并行，副作用按位置逐项审批、串行；状态变更持久化，最后按位置汇总。
- **TurnOrchestrator**：管理初始流、首批工具、一次回灌和最终流；无工具时走原路径；最终阶段调用只记录不执行。
- **ChatController**：保留 TUI 和会话入口，委托回合编排，发布工具与审批状态，处理中断和收尾。
- **上下文构造器**：按回合组合普通消息、助手工具调用和结果；保留已完成、拒绝、失败、超时及中断结果。

### Provider 适配器

- **Anthropic**：转换工具定义、`tool_use`、`input_json_delta`、`tool_result`；保留 thinking、用量和 adaptive 回退，不用 SDK 自动循环。
- **OpenAI Responses**：转换 function tools、参数 delta、`function_call_output`；继续 `store: false`，保留非工具重放状态并去重统一工具记录。
- **OpenAI Chat**：转换 function tools、按 index 关联 `tool_calls` 分片和 `tool` 结果消息；保留文本、用量和错误行为。

### 存储与 TUI

- **工具持久化模块**：新增表和索引，以 `finalizeInitialAssistantAndSaveToolBatch()` 原子终结首轮助手并保存批次，更新审批/运行/结果，恢复时中断非终态；SQLite 仍只在 Worker 中使用。
- **工具记录组件**：按调用顺序显示名称、参数摘要、审批与执行状态、受限结果摘要。
- **审批组件**：显示当前调用、关键参数及命令风险；`Y` 批准、`N` 拒绝，普通输入禁用，`Ctrl+C` 可取消。
- **启动组装模块**：捕获工作区，创建固定限制、守卫、六工具、注册中心、执行器和编排器，不接受配置或模型覆盖限制。

依赖保持单向：

```text
工具契约
  ↑
基础设施与六个工具
  ↑
注册中心 / 执行器
  ↑
组装器 / 审批器 / 批次协调器
  ↑
单回合编排器
  ↑
ChatController / TUI

Provider 适配器 ──→ Provider 统一类型
存储实现       ──→ 存储统一类型
单回合编排器   ──→ Provider 与存储接口
```

## 模块交互

### 启动与恢复

```text
bootstrap → 配置/profile → 捕获并 realpath 工作区 → 创建固定限制与工具系统
          → 组装 Provider/Repository/TurnOrchestrator
          → 数据库迁移 → 非终态工具改为 interrupted
          → getConversation → 发布 AppState → TUI 展示历史
```

工作区根无法解析时应用显示启动错误，不进入可执行工具的聊天状态。

### 普通对话

`beginTurn` 保存用户和助手草稿；初始请求提供六个工具定义；文本、thinking 和用量持续更新。若以普通完成结束，不创建工具记录、不发第二次请求，保持 s01 行为。

### 首轮工具流

Provider 把调用开始、参数片段和结束事件交给组装器。流结束后组装器检查完整性、解析 JSON、查找工具并校验参数。首个助手消息即使正文为空，只要有工具调用也有效；其终结与整批工具记录在同一事务提交。

### 批次执行

```text
有效调用
  ├─ read：mark running → 并行 execute → finish result
  └─ write/command：按 position request approval
       ├─ approved：先保存批准 → mark running → execute → finish result
       └─ denied：保存拒绝与 denied 结果，不调用 executor
```

两分支同时推进，一项失败不取消其他项，最终按模型顺序汇总。无效调用直接保存失败，不审批、不执行。

### 文件调用

- 读取：真实路径边界检查 → 严格 UTF-8 → 字节截断。
- 创建：再次检查父目录与冲突 → 排他创建 → 完整写入和刷新 → 失败清理。
- 修改：再次检查目标 → 严格读取 → 唯一字面匹配 → 同目录临时文件 → 安全替换 → 清理。

审批后执行前必须重新检查外部状态。

### 命令调用

PowerShell 以工作区为 cwd 启动，stdout/stderr 全程消费但只保留上限内 UTF-8 文本并累计原始字节。退出码 0 为成功，非零为 `command_failed` 且保留受限输出。取消或超时终止进程树，排空或关闭管道后返回对应终态。

### 一次回灌

整批收敛后，上下文按“用户消息 → 首个助手文本和调用 → 工具结果”构造；仓储创建第二个助手草稿；final 请求不提供工具定义，流式生成最终文本并结束。

若 final 仍返回调用，保存为 `skipped/agent_loop_limit`，不审批、不执行、不发第三次请求，并在 TUI 提示达到限制。

### 取消与错误

- 首轮取消：停止 Provider，保留部分文本/thinking，助手标为 cancelled，不执行草稿调用。
- 审批/执行取消：中断未决、未启动与活跃调用，保留已完成结果，不回灌。
- 首轮 Provider 错误：助手 failed，不执行未完成调用。
- final Provider 错误：工具结果保持，第二助手 failed，会话仍可用。
- 审批或执行状态持久化失败：尚未启动的副作用不得执行；不继续 final 请求。已发生副作用不可回滚，内存保留真实结果并显示持久化错误。

### 恢复、切换与退出

恢复后 `succeeded`、`failed`、`timed_out`、`denied`、`interrupted` 进入模型历史；不得残留 `pending/queued/running`。Responses 状态过滤已由统一记录表达的 function call。

生成、审批或执行期间拒绝新建/切换会话。退出先取消活动回合并等待 Provider、工具、审批与数据库收尾，再关闭 Worker 和 Ink。

## 文件组织

```text
src/
├── tools/
│   ├── types.ts
│   ├── registry.ts
│   ├── workspace-paths.ts
│   ├── utf8.ts
│   ├── limits.ts
│   ├── executor.ts
│   ├── call-assembler.ts
│   ├── approval-coordinator.ts
│   ├── batch-coordinator.ts
│   └── implementations/
│       ├── read-file.ts
│       ├── write-file.ts
│       ├── edit-file.ts
│       ├── run-command.ts
│       ├── find-files.ts
│       └── search-text.ts
├── providers/{types,anthropic,openai-responses,openai-chat}.ts
├── chat/{turn-orchestrator,controller,context,state}.ts
├── storage/
│   ├── migrations/{index,002-tool-calls}.ts
│   └── {types,repository,worker-protocol,worker}.ts
├── tui/
│   ├── components/{tool-call-card,tool-call-list,tool-approval-panel,message,message-list,prompt-input,status-bar}.tsx
│   └── screens/chat-screen.tsx
├── cli/bootstrap.ts
└── shared/ids.ts

tests/
├── unit/
│   ├── tools/{registry,workspace-paths,utf8,limits,read-file,write-file,edit-file,run-command,find-files,search-text,executor,call-assembler,approval-coordinator,batch-coordinator}.test.ts
│   ├── providers/{anthropic,openai-responses,openai-chat}.test.ts
│   ├── chat/{turn-orchestrator,context}.test.ts
│   └── storage/{migrations,repository}.test.ts
├── integration/{tool-turn,provider-tool-streaming,tool-persistence,chat-controller}.test.ts
├── tui/{tool-components,chat-screen}.test.tsx
├── fixtures/streams/{anthropic-tools,openai-responses-tools,openai-chat-tools}.txt
└── helpers/{mock-llm-client,mock-tool,temporary-workspace}.ts

spec_docs/s02/{spec,plan,task,checklist}.md
Project_Guide/s02.md
AGENT.md
README.md
```

新建文件承担新工具域、回合编排、第二版迁移和工具 TUI；现有 Provider、控制器、上下文、状态、存储协议/Worker、聊天组件、bootstrap 和 ID 模块按上文接口扩展。测试使用隔离临时工作区和模拟 SDK 事件，不操作仓库文件或外网。路径测试覆盖 Windows 盘符大小写、`..`、绝对路径、符号链接和 junction；系统不支持链接时明确跳过对应能力测试。

`AGENT.md` 更新当前状态和有限工具边界；`README.md` 记录工具、审批、工作区与命令风险；`Project_Guide/s02.md` 保存中文导读和真实验收结果。新增手写注释使用 `[s02]`；替换 s01 手写代码时就近保留并注明 `[s01 旧实现，s02 替换]`。不手工编辑 `dist/`、`coverage/` 或锁文件。

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 总体架构 | 统一工具事件与协议无关编排层 | 三个 Provider 只处理格式差异，审批、执行、持久化和回灌只实现一次 |
| 工具契约 | TypeScript 接口 + JSON Schema + 运行时校验 | 模型描述与不可信输入校验职责分离 |
| 参数校验 | 复用 Zod Schema | 项目已有依赖，避免描述和校验漂移 |
| 工具登记 | 启动时显式注册六工具 | 固定、可审计、顺序稳定，不引入动态发现 |
| 工作区 | 启动时 realpath `process.cwd()`；只收相对路径 | 防止运行期漂移并尽早拒绝绝对路径 |
| 边界判断 | realpath + Windows 大小写无关路径段比较 | 处理穿越、盘符、符号链接和 junction |
| 新文件 | 验证最近存在父目录，再排他创建 | 目标不存在时仍能验证链接边界且不覆盖 |
| UTF-8 | 严格解码 + 二进制信号检查 | 不猜测或转换编码 |
| 创建语义 | 父目录须存在，排他创建，失败清理 | 控制副作用并避免残缺文件 |
| 修改语义 | 字符串字面唯一匹配 | 不引入正则、补丁或行号语义 |
| 修改提交 | 同目录临时文件 + Windows 安全替换 | 降低部分写入风险，失败保留原件 |
| glob | Node.js 24 标准文件系统 glob | 不新增依赖，符合固定运行环境 |
| 文本搜索 | 应用内普通字符串搜索 | 不依赖外部 rg，统一 UTF-8、边界和上限 |
| 命令 | 显式 PowerShell，cwd 为工作区 | 对齐 Windows/PowerShell 环境和审批展示 |
| 命令边界 | 不声称沙箱，只做逐项审批与风险提示 | 如实反映外部路径、网络和子进程能力 |
| 命令终止 | 终止 Windows 进程树 | 避免遗留子进程 |
| 超时 | 合并 `AbortSignal.timeout()` 与回合取消 | 统一工具取消，模型不可覆盖 |
| 固定超时 | 文件/搜索 10 秒；命令 60 秒 | 普通 I/O 快速失败，构建测试需要较长窗口 |
| 结果上限 | 文本、stdout、stderr 各 64 KiB；匹配 500 | 限制上下文、内存和 SQLite 数据量 |
| 截断 | UTF-8 字节安全截断并统计原始规模 | 不破坏 Unicode，模型可判断完整性 |
| 输出采集 | 全程消费管道，只保留上限内数据 | 避免背压卡死和内存无界增长 |
| 调度 | read 用 `Promise.allSettled`；副作用按 position 串行；两分支并行 | 单项失败隔离、保留依赖顺序并满足已选策略 |
| 审批 | 每调用一个 Promise，TUI 一次一个 | 支持部分批准且避免焦点冲突 |
| 审批落库 | 决定先写 SQLite 再执行 | 防止未可靠记录的副作用 |
| 标识 | MyCode UUID 与供应商 call ID 分离 | 分别满足内部主键和协议回灌 |
| 参数解析 | 首轮流结束后统一解析校验 | 避免不完整 JSON 误执行 |
| final 阶段 | 不提供工具定义，仍硬性阻止新调用 | 降低第二批概率并兼容异常服务 |
| 第二批调用 | `skipped/agent_loop_limit` | 可见、可持久化但不审批、不执行、不重试 |
| 结果回灌 | 结构化 JSON 字符串 | 三协议均可承载且状态语义明确 |
| Responses 重放 | 保留非工具 output，统一记录恢复工具并去重 | 避免 function call 重复发送 |
| 存储 | 独立 `tool_calls` 表关联助手消息 | 工具状态生命周期独立、便于更新恢复 |
| 迁移 | 新增版本 2，不改版本 1 | 保留 s01 数据库升级路径 |
| 恢复 | 非终态原子标为 interrupted | 不自动重试副作用或误报成功 |
| TUI | 工具卡挂在助手消息下，审批面板位于输入区上方 | 历史关联直观，当前决策突出 |
| 按键 | `Y` 批准、`N` 拒绝、`Ctrl+C` 取消回合 | 终端输入稳定、语义明确 |
| 取消 | 取消整个当前回合 | 多分支下保持确定状态；已完成结果保留 |
| 测试 | 临时工作区、模拟流、临时 SQLite、本地子进程 | 不依赖真实文件、密钥、网络或供应商 |
| 依赖 | 不新增运行时依赖 | Node 24、Zod、现有 SDK 与标准库足够 |
| 留痕 | 新内容 `[s02]`，替换内容保留 s01 旧实现 | 满足项目可追溯约束 |
| 构建产物 | 不手工编辑 dist/coverage | 只维护源码和测试来源 |

### 固定应用限制

```ts
const toolLimits = {
  fileTimeoutMs: 10_000,
  searchTimeoutMs: 10_000,
  commandTimeoutMs: 60_000,
  maxTextBytes: 65_536,
  maxStdoutBytes: 65_536,
  maxStderrBytes: 65_536,
  maxMatches: 500,
} as const;
```

### Spec 覆盖

- F1：统一工具契约与三个 Provider 的工具定义转换。
- F2：单一 `ToolRegistry` 登记、查找和定义导出。
- F3：`ReadFile`、路径守卫、UTF-8 守卫和结果截断。
- F4：`WriteFile` 的排他创建、审批和边界复检。
- F5：`EditFile` 的唯一字面匹配、安全替换和审批。
- F6：`RunCommand`、PowerShell 启动、风险提示和输出捕获。
- F7：`FindFiles` 的 glob 查找、相对路径和匹配限制。
- F8：`SearchText` 的普通文本搜索、UTF-8 过滤和位置输出。
- F9：统一工作区真实路径守卫及链接逃逸防护。
- F10：审批协调器、审批面板和副作用逐项授权。
- F11：拒绝结果持久化及整批回灌。
- F12：Provider 工具事件与调用组装器。
- F13：只读并行、副作用串行的批次协调器。
- F14：单回合编排器的一次整批结果回灌。
- F15：final 阶段和 `agent_loop_limit` 硬性阻止。
- F16：执行器固定超时与取消合并。
- F17：UTF-8 字节截断、匹配上限及原始规模统计。
- F18：统一工具错误及单项失败隔离。
- F19：工具卡片、状态栏和审批组件。
- F20：数据库迁移、工具仓储和上下文恢复。
- F21：统一 Provider 类型和三个协议适配器。

没有未归属的功能需求。
