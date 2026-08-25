# MyCode Agent Loop Plan

## 架构概览

### ChatController：应用入口与事件消费者

`ChatController` 继续接收 TUI 操作，但不再包含 Agent 循环细节。它识别普通消息、`/plan` 和 `/do`，读取或更新当前会话模式，启动、取消并消费一次 Agent 运行，将 Agent 事件投影到持久化记录和 `AppState`，并把现有 `Y/N` 决定交给审批协调器。TUI 仍只依赖控制器，Agent 核心完全不依赖 TUI。

### AgentRunner：独立异步事件源

`AgentRunner` 以异步生成器运行一个用户任务：准备上下文，调用模型，收集响应，安全执行工具并回写结果，直到模型自然完成或触发停止条件。它维护当前迭代、累计 Token、连续未知工具次数和内存中的有序对话记录，并统一产生文本、工具、用量、进度及停止事件。

### StreamCollector：实时事件与完整结果双路输出

每次模型请求由独立收集器消费。分片到达时立即向外产生文本、思考、工具调用和用量事件，同时累积完整正文、思考内容、工具参数、结束原因、Provider 重放状态及本次用量。流结束后返回完整迭代结果，供 `AgentRunner` 判断自然完成、错误或工具批次。

### Ordered Context：多轮工具上下文

模型请求使用严格有序的上下文表达任意多轮工具链：

```text
用户消息
→ 助手第 1 次响应及工具调用
→ 第 1 批工具结果
→ 助手第 2 次响应及工具调用
→ 第 2 批工具结果
→ …
```

三种 Provider 分别把同一有序上下文转换成自己的协议格式，供应商差异不泄漏给 Agent。

### SafetyBatchScheduler：带屏障的工具调度

连续只读调用组成并发段；每个写入或命令调用单独构成串行安全段；一个段完全结束后才进入下一段。单项失败只生成自己的结果，不阻断其他合法调用。Plan Mode 的不可用工具在执行和审批前被拦截。底层六个工具、执行器、超时、工作区守卫和审批协调器继续复用。

### AgentEventProjector：事件持久化投影

控制器通过独立投影组件顺序处理事件：创建和更新每次迭代的助手消息，保存工具调用及结果，节流保存流式正文和思考内容，保存 Agent 回合状态、停止原因和累计用量，更新会话模式及最新计划引用，并生成供 TUI 使用的不可变状态。异步生成器的背压保证关键事件持久化完成后 Agent 才继续推进。

### 存储与 TUI

存储增加 Agent 回合、会话模式、最新计划引用以及消息的回合和迭代关联。启动恢复时，未完成回合和消息统一标记为中断，但不自动续跑。TUI 继续只渲染 `AppState`，新增模式、当前迭代、回合累计 Token、Agent 阶段和停止原因。

整体依赖保持单向：

```text
TUI
 ↓
ChatController
 ↓
AgentEventProjector ← Storage
 ↓
AgentRunner
 ├─ StreamCollector → Provider
 ├─ AgentContext
 └─ SafetyBatchScheduler → Registry / Approval / Executor
```

## 核心数据结构

### Agent 运行与停止状态

```ts
export type AgentMode = 'plan' | 'execute';

export type AgentRunStatus =
  | 'running'
  | 'completed'
  | 'stopped'
  | 'cancelled'
  | 'failed'
  | 'interrupted';

export type AgentStopReason =
  | 'natural_completion'
  | 'iteration_limit'
  | 'unknown_tool_limit'
  | 'user_cancelled'
  | 'stream_error'
  | 'storage_error'
  | 'process_interrupted';

export type AgentPhase =
  | 'preparing'
  | 'streaming'
  | 'scheduling_tools'
  | 'awaiting_approval'
  | 'executing_tools'
  | 'finishing';
```

工具自身失败、拒绝或超时不是 Agent 停止原因；它们作为结果回写模型。只有循环级错误或明确停止条件才结束整个运行。

```ts
export interface AgentRunInput {
  runId: string;
  sessionId: string;
  trigger: 'message' | 'do';
  mode: AgentMode;
  instruction: string;
  context: ModelContextItem[];
  limits: {
    maxIterations: 20;
    maxUnknownToolIterations: 3;
  };
}

export interface AgentRunResult {
  runId: string;
  status: Exclude<AgentRunStatus, 'running'>;
  stopReason: AgentStopReason;
  iterationCount: number;
  usage: Usage;
  finalIterationId: string | null;
}
```

普通消息的 `instruction` 是用户原文。`/do` 在界面和历史中显示为 `/do`，传给本次 Agent 的指令规范化为“根据当前会话中的最近计划立即执行”。

### 有序模型上下文

```ts
export interface ModelMessageItem {
  type: 'message';
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  providerState?: ProviderState;
}

export interface ModelToolCall {
  callId: string;
  name: string;
  argumentsText: string;
  arguments: JsonObject | null;
}

export interface ModelAssistantIterationItem {
  type: 'assistant_iteration';
  messageId: string;
  content: string;
  providerState?: ProviderState;
  toolCalls: ModelToolCall[];
}

export interface ModelToolResultsItem {
  type: 'tool_results';
  assistantMessageId: string;
  results: Array<{
    callId: string;
    name: string;
    result: ToolExecutionResult;
  }>;
}

export type ModelContextItem =
  | ModelMessageItem
  | ModelAssistantIterationItem
  | ModelToolResultsItem;

export interface ChatRequest {
  items: ModelContextItem[];
  tools: ToolDefinition[];
}
```

`argumentsText` 保留供应商实际返回的参数；`arguments` 只有在 JSON 完整且为对象时存在。s02 的 `phase`、顶层 `toolCalls`、`toolResults` 和临时 `toolHistory` 字段被有序上下文替换。

### Agent 事件

```ts
interface AgentEventBase {
  runId: string;
  sessionId: string;
  at: number;
}

export type AgentEvent =
  | (AgentEventBase & {
      type: 'run_started';
      mode: AgentMode;
      maxIterations: number;
    })
  | (AgentEventBase & {
      type: 'iteration_started';
      iterationId: string;
      iteration: number;
    })
  | (AgentEventBase & {
      type: 'text_delta' | 'thinking_delta';
      iterationId: string;
      delta: string;
    })
  | (AgentEventBase & {
      type: 'usage_updated';
      iterationId: string;
      iterationUsage: Usage;
      totalUsage: Usage;
    })
  | (AgentEventBase & {
      type: 'tool_call_started';
      iterationId: string;
      callId: string;
      providerCallId: string | null;
      position: number;
      name: string;
    })
  | (AgentEventBase & {
      type: 'tool_arguments_delta';
      iterationId: string;
      callId: string;
      delta: string;
    })
  | (AgentEventBase & {
      type: 'tool_call_ready';
      iterationId: string;
      call: PreparedToolCall;
    })
  | (AgentEventBase & {
      type: 'approval_requested' | 'approval_resolved';
      iterationId: string;
      callId: string;
      prompt: ToolApprovalPrompt;
      decision?: ApprovalDecision;
    })
  | (AgentEventBase & {
      type: 'tool_status';
      iterationId: string;
      callId: string;
      status: ToolExecutionStatus;
    })
  | (AgentEventBase & {
      type: 'tool_result';
      iterationId: string;
      callId: string;
      result: ToolExecutionResult;
    })
  | (AgentEventBase & {
      type: 'progress';
      iteration: number;
      maxIterations: number;
      phase: AgentPhase;
      completedTools: number;
      totalTools: number;
    })
  | (AgentEventBase & {
      type: 'iteration_finished';
      iterationId: string;
      iteration: number;
      response: CollectedIteration;
    })
  | (AgentEventBase & {
      type: 'run_finished';
      result: AgentRunResult;
    });
```

原始参数分片事件用于实时观察；只有 `tool_call_ready` 表示调用已完整组装、分类并可持久化或执行。

### 单次流收集结果

```ts
export interface CollectedIteration {
  iterationId: string;
  iteration: number;
  text: string;
  thinking: string;
  usage: Usage;
  finishReason: FinishReason | null;
  providerState: ProviderState | null;
  calls: PreparedToolCall[];
  error: ProviderError | null;
}

export interface StreamCollector {
  collect(input: {
    runId: string;
    sessionId: string;
    iterationId: string;
    iteration: number;
    stream: AsyncIterable<StreamEvent>;
    toolPolicy: ToolPolicy;
  }): AsyncGenerator<AgentEvent, CollectedIteration, void>;
}
```

`AgentRunner` 手动驱动收集器生成器：未结束值立即向外转发，结束值作为完整响应继续判断。

### 工具分类与安全批次

```ts
export type ToolAvailability =
  | 'available'
  | 'unknown'
  | 'invalid'
  | 'unavailable_in_mode';

export type PreparedToolCall =
  | {
      availability: 'available';
      call: ToolCall;
      argumentsText: string;
    }
  | {
      availability: Exclude<ToolAvailability, 'available'>;
      draft: ToolCallDraft;
      result: ToolExecutionResult;
    };

export interface ToolPolicy {
  mode: AgentMode;
  definitions(): ToolDefinition[];
  prepare(draft: ToolCallDraft): PreparedToolCall;
}

export type ToolExecutionSegment =
  | {kind: 'parallel_reads'; calls: ToolCall[]}
  | {kind: 'side_effect'; call: ToolCall};

export interface ToolBatchResult {
  orderedResults: Array<{
    call: PreparedToolCall;
    result: ToolExecutionResult;
  }>;
}

export interface SafetyBatchScheduler {
  execute(input: {
    runId: string;
    sessionId: string;
    iterationId: string;
    calls: PreparedToolCall[];
    signal: AbortSignal;
  }): AsyncGenerator<AgentEvent, ToolBatchResult, void>;
}
```

Plan Mode 的工具定义只包含 `read`，但分类使用完整注册中心，因此写入或命令成为 `unavailable_in_mode`，而不是 `unknown`。

### 持久化结构

```ts
export interface AgentRunRecord {
  id: string;
  sessionId: string;
  userMessageId: string;
  mode: AgentMode;
  status: AgentRunStatus;
  stopReason: AgentStopReason | null;
  iterationCount: number;
  inputTokens: number;
  outputTokens: number;
  startedAt: number;
  finishedAt: number | null;
  updatedAt: number;
}
```

`Session` 增加：

```ts
agentMode: AgentMode;
latestPlanMessageId: string | null;
```

`StoredMessage` 增加：

```ts
agentRunId: string | null;
iteration: number | null;
```

`ToolCallRecord` 增加：

```ts
agentRunId: string | null;
argumentsText: string;
```

旧 s01/s02 记录允许 `agentRunId` 为空；s03 创建的新迭代和工具记录由应用保证非空。`iterationId` 直接等于 `assistantMessageId`，不在工具表保存重复列。会话恢复对象增加 `agentRuns`。

### 存储接口

```ts
interface SessionRepositoryContract {
  beginAgentRun(input: {
    runId: string;
    sessionId: string;
    displayText: string;
    mode: AgentMode;
  }): Promise<{
    run: AgentRunRecord;
    userMessage: StoredMessage;
  }>;

  beginAgentIteration(input: {
    messageId: string;
    runId: string;
    sessionId: string;
    iteration: number;
  }): Promise<StoredMessage>;

  checkpointAssistant(
    messageId: string,
    content: string,
    thinking: string,
  ): Promise<void>;

  finalizeIterationWithToolBatch(
    messageId: string,
    message: FinalMessageUpdate,
    calls: ToolCallRecord[],
  ): Promise<void>;

  updateToolCall(record: ToolCallRecord): Promise<void>;

  finishAgentRun(
    runId: string,
    result: AgentRunResult,
    latestPlanMessageId?: string,
  ): Promise<void>;

  setSessionMode(
    sessionId: string,
    mode: AgentMode,
  ): Promise<Session>;

  getConversation(
    sessionId: string,
  ): Promise<StoredConversation | null>;
}
```

Plan Mode 自然完成时，`finishAgentRun` 在同一事务中更新回合和会话最新计划引用。

## 模块设计

### `src/agent/types.ts`

**职责：** 定义 Agent 模式、运行状态、停止原因、阶段、事件、运行输入和最终结果。

**对外接口：** `AgentMode`、`AgentPhase`、`AgentStopReason`、`AgentRunInput`、`AgentRunResult`、`AgentEvent`。

**依赖：** 仅依赖 Provider 和工具层的纯类型，不依赖存储、聊天控制器或 TUI。

### `src/agent/tool-policy.ts`

**职责：** 根据模式输出工具定义，使用完整注册中心区分未知和模式不可用工具，解析参数并形成 `PreparedToolCall`，保留原始参数和供应商调用标识。

**对外接口：**

```ts
class ToolPolicy {
  constructor(registry: ToolRegistry, mode: AgentMode);
  definitions(): ToolDefinition[];
  prepare(draft: ToolCallDraft): PreparedToolCall;
}
```

**依赖：** `ToolRegistry`、工具契约和 Agent 模式类型。

### `src/agent/stream-collector.ts`

**职责：** 消费一次 Provider 模型流，实时转发分片事件，同时累积完整响应；流结束时完成调用组装和策略分类；区分正常结束、显式错误和异常中断；为调用生成稳定应用 ID。

**对外接口：**

```ts
class StreamCollector {
  collect(input: StreamCollectorInput):
    AsyncGenerator<AgentEvent, CollectedIteration, void>;
}
```

**依赖：** Provider 统一流类型、`ToolPolicy`、工具调用组装逻辑和 ID 生成器。

### `src/agent/safety-batch-scheduler.ts`

**职责：** 切分连续只读并发段和单项副作用段；无效、未知和模式不可用调用直接产生结构化结果；副作用触发现有审批；产生状态、结果和进度事件；最终按原始位置返回结果。

**对外接口：**

```ts
class SafetyBatchScheduler {
  constructor(
    executor: ToolExecutor,
    approvals: ApprovalCoordinator,
  );

  execute(input: SchedulerInput):
    AsyncGenerator<AgentEvent, ToolBatchResult, void>;
}
```

**依赖：** 工具执行器、审批协调器和 Agent 事件类型。

### `src/agent/context.ts`

**职责：** 从恢复数据构造严格有序上下文，在内存追加本次助手迭代及工具结果，保留 Responses 重放状态，排除不可重放的残缺内容。

**对外接口：**

```ts
class AgentContext {
  static fromConversation(
    conversation: StoredConversation,
  ): AgentContext;

  items(): readonly ModelContextItem[];
  appendUserMessage(item: ModelMessageItem): void;
  appendIteration(item: ModelAssistantIterationItem): void;
  appendToolResults(item: ModelToolResultsItem): void;
}
```

**依赖：** 有序上下文类型；构造入口读取存储类型，但运行时不调用仓储。

### `src/agent/runner.ts`

**职责：** 驱动完整 ReAct 循环；创建稳定迭代 ID；手动驱动收集器和调度器；维护内存上下文、计数和用量；通过事件背压等待持久化；统一处理全部停止条件。

**对外接口：**

```ts
class AgentRunner {
  constructor(
    client: LLMClient,
    registry: ToolRegistry,
    collector: StreamCollector,
    scheduler: SafetyBatchScheduler,
  );

  run(
    input: AgentRunInput,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent, AgentRunResult, void>;
}
```

**依赖：** Provider 客户端、工具注册中心、收集器、调度器和内存上下文。明确不依赖 Repository、`AppState`、React 或 Ink。

### `src/providers/types.ts` 与 Provider 适配器

Provider 类型以 `ModelContextItem[]` 替换两阶段请求字段，并保留统一流事件。Anthropic、OpenAI Responses 和 OpenAI Chat 按原始顺序转换助手调用及工具结果；Responses 优先重放完整 `providerState`；所有 Provider 禁用 SDK 自动工具循环。

### `src/chat/agent-event-projector.ts`

**职责：** 顺序消费事件；创建和更新迭代消息；节流 checkpoint；原子终结消息并保存调用；更新工具记录；完成回合和计划引用；归约不可变 `AppState`。

**对外接口：**

```ts
class AgentEventProjector {
  constructor(
    repository: SessionRepositoryContract,
    initialState: AppState,
    publish: (state: AppState) => void,
  );

  project(event: AgentEvent): Promise<void>;
  flush(): Promise<void>;
}
```

### `src/chat/commands.ts`

**职责：** 精确识别去除首尾空白后的 `/plan` 和 `/do`；带额外文本时按普通用户消息处理。

```ts
type ChatCommand = 'plan' | 'do' | null;
function parseChatCommand(text: string): ChatCommand;
```

### `src/chat/controller.ts`

普通消息创建 Agent 回合并消费事件；`/plan` 只切换模式；`/do` 验证计划、切换模式并立即创建执行回合；取消中断 Runner、审批和工具；会话切换恢复完整状态。控制器不再解析 Provider 流或实现固定两阶段工具流程。

### 存储模块

数据库版本 3 增加 Agent 回合表，并为会话、消息和工具调用增加所需字段。Repository、Worker 协议和 Worker 实现提供开始回合、开始迭代、原子终结迭代与工具批次、完成回合及切换模式操作。初始化时统一中断遗留非终态。

### TUI 状态与组件

`AppState` 增加当前模式、运行 ID、迭代进度、累计用量和停止原因。状态栏显示 `PLAN` 或 `DO`、`N/20` 和回合累计 Token。消息列表展示独立助手迭代并继续关联工具卡片。审批面板及 `Y/N` 键位不变。

### 测试支持

模拟客户端按请求序号返回不同模型流；受控测试流支持暂停、释放、中断、显式错误和意外结束；记录每次有序上下文和工具定义，以验证 AC1–AC21。

## 模块交互

### 启动与恢复

```text
CLI bootstrap
→ 创建 Provider、Repository、工具系统和 AgentRunner
→ 执行数据库迁移
→ 中断遗留运行、消息和工具调用
→ 读取完整 Conversation
→ 恢复消息、工具、回合、模式和最新计划
→ 发布 AppState
```

恢复只展示现场，不自动继续模型请求、审批或工具执行。

### 普通回合与迭代屏障

```text
用户消息
→ 原子创建 user 消息和 AgentRunRecord
→ 构造 AgentContext
→ AgentRunner.run()
→ iteration_started
→ Projector 创建 streaming assistant
→ Provider 流与实时事件
→ iteration_finished
→ Projector 冲刷 checkpoint 并原子完成消息、保存工具批次
→ 工具调度或自然完成
```

`iteration_finished` 的持久化完成之前，副作用调度不会开始。

### 工具调度与上下文回写

```text
CollectedIteration.calls
→ ToolPolicy 分类
→ SafetyBatchScheduler 划分安全段
→ 逐段审批、执行和持久化
→ ToolBatchResult 按原始位置排序
→ AgentContext 追加 assistant_iteration
→ AgentContext 追加 tool_results
→ 下一次模型迭代
```

并发读取结果事件可按实际完成顺序出现，但模型回写顺序固定按原始位置。

### 未知工具与迭代上限

本轮全部为 `unknown` 时连续计数加一，否则清零。前两轮错误回写模型；第三轮保存结果后以 `unknown_tool_limit` 停止。第 20 次响应若仍有工具调用，为所有调用生成 `agent_loop_limit` 结果，不审批、不执行、不发起第 21 次请求。

### `/plan`

```text
/plan
→ setSessionMode(plan)
→ 不创建 Agent 回合，不请求模型
→ 后续普通任务只公开三个只读工具
→ 自然完成时原子更新 latestPlanMessageId
```

### `/do`

存在计划时：

```text
/do
→ setSessionMode(execute)
→ 原子创建显示为 /do 的 user 消息和 AgentRunRecord
→ 使用明确的内部执行指令和完整会话上下文
→ 提供全部六个工具并立即运行
```

没有计划时只切换模式、显示错误，不创建运行或请求模型。

### 用户取消

取消传播到 Provider、审批和工具执行。已完成调用保留；当前消息保存部分内容；运行中、待审批和未开始调用标为 `interrupted`；不进入下一安全段或模型迭代；回合以 `user_cancelled` 结束。

### 模型流与存储错误

显式流错误或无终止事件的异常结束保存部分响应，当前迭代和回合失败，不执行本次调用且不重试。Projector 写盘失败时 Controller 立即中断 Runner、审批和工具，尝试记录 `storage_error`，并向界面发布真实失败。

### 三协议转换

```text
Anthropic:
message(user) → assistant(text + tool_use) → user(tool_result)

OpenAI Chat:
user → assistant(content + tool_calls) → tool messages

OpenAI Responses:
input messages / providerState output items → function_call_output
```

Responses 的 `providerState` 已包含迭代输出时不重复生成相同文本和 function call。

## 文件组织

```text
MyCode/
├── src/
│   ├── agent/
│   │   ├── types.ts                       — 新建：Agent 类型与事件
│   │   ├── tool-policy.ts                 — 新建：模式工具策略
│   │   ├── stream-collector.ts            — 新建：流式双路收集
│   │   ├── context.ts                     — 新建：有序上下文
│   │   ├── safety-batch-scheduler.ts      — 新建：安全屏障调度
│   │   └── runner.ts                      — 新建：ReAct 循环
│   ├── chat/
│   │   ├── agent-event-projector.ts       — 新建：事件持久化投影
│   │   ├── commands.ts                    — 新建：/plan 与 /do
│   │   ├── controller.ts                  — 修改：委托 AgentRunner
│   │   ├── context.ts                     — 修改：兼容有序上下文入口
│   │   └── state.ts                       — 修改：Agent UI 状态
│   ├── providers/
│   │   ├── types.ts                       — 修改：有序 ChatRequest
│   │   ├── anthropic.ts                   — 修改：多轮工具转换
│   │   ├── openai-responses.ts            — 修改：多轮重放
│   │   └── openai-chat.ts                 — 修改：多轮工具消息
│   ├── storage/
│   │   ├── migrations/
│   │   │   ├── 003-agent-loop.ts          — 新建：数据库版本 3
│   │   │   └── index.ts                   — 修改：登记迁移
│   │   ├── types.ts                       — 修改：回合与关联类型
│   │   ├── worker-protocol.ts             — 修改：新操作
│   │   ├── worker.ts                      — 修改：事务与恢复
│   │   └── repository.ts                  — 修改：仓储门面
│   ├── tools/
│   │   ├── types.ts                       — 修改：模式不可用错误、原始参数
│   │   ├── approval-coordinator.ts        — 小改：取消协作
│   │   ├── call-assembler.ts              — 保留：s02 历史实现
│   │   └── batch-coordinator.ts           — 保留：s02 历史实现，不再用于主流程
│   ├── tui/
│   │   ├── screens/chat-screen.tsx        — 修改：Agent 忙碌与命令输入
│   │   └── components/
│   │       ├── status-bar.tsx             — 修改：模式、进度和总 Token
│   │       ├── message-list.tsx            — 修改：迭代展示
│   │       └── tool-call-card.tsx          — 修改：新终态摘要
│   └── cli/bootstrap.ts                    — 修改：组合 Agent 依赖
├── tests/
│   ├── helpers/
│   │   ├── mock-llm-client.ts              — 修改：多请求流
│   │   └── controlled-stream.ts            — 新建：受控异步流
│   ├── unit/agent/
│   │   ├── tool-policy.test.ts
│   │   ├── stream-collector.test.ts
│   │   ├── context.test.ts
│   │   ├── safety-batch-scheduler.test.ts
│   │   └── runner.test.ts
│   ├── unit/chat/commands.test.ts
│   ├── unit/providers/                     — 修改：多轮有序上下文测试
│   ├── unit/storage/                       — 修改：版本 3 和事务测试
│   ├── integration/
│   │   ├── agent-loop.test.ts
│   │   ├── plan-mode.test.ts
│   │   ├── agent-cancellation.test.ts
│   │   ├── agent-recovery.test.ts
│   │   └── 既有集成测试                   — 修改：s03 回归
│   └── tui/                                — 修改：模式、进度、取消和审批
├── spec_docs/s03/
│   ├── spec.md
│   ├── plan.md
│   ├── task.md
│   └── checklist.md
├── Project_Guide/s03.md                    — 新建：中文导读和验证证据
├── AGENT.md                                — 修改：当前状态 s03
└── README.md                               — 修改：Agent Loop 与 Plan Mode
```

不删除 s01、s02 文档。s02 编排代码保留为历史实现。修改已有手写实现时就近保留被替换代码并注明 s03 替换。不新增运行时依赖，不手工编辑生成目录或锁文件。

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| Agent 对外边界 | `AsyncGenerator<AgentEvent>` | 原生支持异步、取消和消费背压，无需事件库或状态机框架。 |
| 流式双路收集 | 实时 `yield`，结束值返回完整响应 | 同一份 Provider 流只消费一次。 |
| 持久化推进 | Projector 写盘后才请求下一事件 | 利用背压形成副作用前的持久化屏障。 |
| 循环状态 | 只由 `AgentRunner` 持有 | 避免 Controller 与 Runner 出现双重真相。 |
| Provider 请求 | 严格有序的 `ModelContextItem[]` | 支持任意多轮工具链。 |
| Provider 自动循环 | 禁用 | 三协议共享应用层停止和审批语义。 |
| 迭代 ID | 复用助手消息 UUID | 统一关联且避免重复字段。 |
| 迭代上限 | 固定 20；第 20 次调用不执行 | 保证停止时不留下未经观察的新副作用。 |
| 未知阈值 | 固定连续 3 个全未知迭代 | 允许纠错并限制失控循环。 |
| Plan Mode | 公开只读定义，完整注册中心负责分类 | 区分未知和模式不可用。 |
| 工具调度 | 连续只读并发段与单项副作用屏障 | 保留因果顺序与安全并发。 |
| 审批 | 复用逐项 Y/N | 不扩大或降低 s02 权限边界。 |
| 取消审批 | 解除 Promise 后优先检查取消信号 | 取消不误记为普通拒绝。 |
| 结果排序 | 实时按完成顺序，模型回写按位置 | 兼顾响应性和确定性。 |
| Token | 每次 Provider 用量，Runner 求和 | 不自行估算。 |
| 命令解析 | 精确小写 `/plan`、`/do` | 避免误吞普通文本。 |
| `/do` 指令 | 历史显示原命令，运行使用明确指令 | 保留操作记录并降低模型歧义。 |
| 最新计划 | 指向最近自然完成的计划消息 | 无需复制正文，失败不覆盖旧计划。 |
| 模式存储 | 会话字段，旧会话默认 execute | 模式属于会话且可恢复。 |
| 回合存储 | 新增 `agent_runs` | 独立保存回合终态和累计用量。 |
| 旧数据 | 旧记录回合关联可空，新记录非空 | 不伪造 s01/s02 历史。 |
| 原始参数 | 新增 `arguments_text` 并从旧 JSON 回填 | 支持无效参数诊断与协议重放。 |
| 事务 | 开始回合、完成迭代、完成计划分别原子提交 | 覆盖关键窗口而不持有长事务。 |
| checkpoint | UI 每 delta；SQLite 约 200ms 节流 | 兼顾流畅和磁盘负载。 |
| 流错误 | 不自动重试 | 避免重复文本和副作用。 |
| 重启 | 非终态统一中断，不续跑 | 当前没有幂等与权限保障。 |
| Responses | 优先重放 providerState | 保留完整输出语义并避免重复。 |
| 无效调用 | 保留原始参数，必要时用安全空对象重建 | 保证错误结果能进入下一轮。 |
| 事件日志 | 不持久化完整日志 | 行为恢复所需状态已有专门记录。 |
| s02 编排 | 保留但断开主流程 | 满足状态留痕并保留历史阅读价值。 |
| 新依赖 | 不新增 | 现有环境足够实现全部能力。 |

## Spec 覆盖

| 功能需求 | 架构归属 |
|----------|----------|
| F1–F5 | `AgentRunner`、`AgentContext`、`AgentEventProjector` |
| F6 | `AgentRunner`、`SafetyBatchScheduler`、`ChatController` |
| F7 | `ToolPolicy`、`AgentRunner` |
| F8 | `StreamCollector`、`AgentRunner`、Projector |
| F9–F11 | Agent 事件类型、`StreamCollector`、Projector、TUI |
| F12–F13 | `SafetyBatchScheduler`、`ToolPolicy` |
| F14 | `AgentContext`、`AgentRunner`、Provider 适配器 |
| F15–F18 | 命令解析、`ChatController`、`ToolPolicy`、存储版本 3 |
| F19 | `StreamCollector`、`AgentRunner`、`agent_runs`、TUI |
| F20 | `SafetyBatchScheduler`、现有审批协调器、TUI |
| F21 | 有序 Provider 请求和三个适配器 |

所有功能需求均有明确架构归属；模块依赖单向，不要求 Provider、工具、存储或 TUI 反向依赖 AgentRunner。

## 实施偏差记录

自动回归证明 s01/s02 的 Provider 单元测试仍直接构造旧 `messages/phase/toolHistory` 请求。为保持 N11 回归能力并遵守“保留每个阶段代码”的项目要求，s03 主流程已全面使用 `ModelContextItem[]`，旧请求字段和 `LegacyChatController` 则作为非主流程兼容/状态留痕长期保留；组合根只实例化新的 `ChatController`，不会进入固定两阶段循环。2026-08-23 收尾验收确认：删除兼容入口不再是 s03 完成条件，除非未来先明确变更状态留痕规则。
