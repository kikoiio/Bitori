# MyCode Plan

## 架构概览

MyCode 采用分层架构，将启动配置、终端界面、对话编排、供应商协议和本地存储分开。核心依赖方向如下：

```text
CLI 启动层
  ├─> 配置层
  ├─> 终端生命周期
  └─> Ink TUI
        └─> 对话控制层
              ├─> 统一 LLMClient
              │     ├─> AnthropicClient
              │     ├─> OpenAIResponsesClient
              │     └─> OpenAIChatClient
              └─> SessionRepository
                    └─> Storage Worker
                          └─> Node SQLite
```

依赖只向内层接口流动：TUI 不使用供应商 SDK 或 SQL；Provider 不读取 TUI 或数据库；存储层不理解供应商协议。`ChatController` 是唯一协调流事件、界面状态和持久化的模块。

## 核心数据结构

### 配置

```ts
type Protocol =
  | 'anthropic'
  | 'openai-responses'
  | 'openai-chat';

type ThinkingConfigSource =
  | boolean
  | {type: 'adaptive'}
  | {
      type: 'manual';
      budget_tokens: number;
      max_tokens: number;
    };

type ThinkingConfig =
  | {type: 'disabled'}
  | {type: 'auto'}
  | {type: 'adaptive'}
  | {
      type: 'manual';
      budgetTokens: number;
      maxTokens: number;
    };

interface ProviderProfileSource {
  name: string;
  protocol: Protocol;
  model: string;
  base_url: string;
  api_key: string;
  thinking?: ThinkingConfigSource;
}

interface ProviderProfile {
  name: string;
  protocol: Protocol;
  model: string;
  baseUrl: string;
  apiKey: string;
  thinking: ThinkingConfig;
}

interface ProfileSummary {
  name: string;
  protocol: Protocol;
  model: string;
}
```

`ProviderProfileSource` 表示 YAML 原始数据；`ProviderProfile` 是解析密钥后的运行时对象。完整 profile 只由 bootstrap、Provider 工厂和控制器私有持有。TUI 状态只暴露不含密钥的 `ProfileSummary`。

### Provider 输入与输出

```ts
type MessageRole = 'user' | 'assistant';

interface ProviderState {
  protocol: 'openai-responses';
  payload: unknown;
}

interface ChatMessage {
  role: MessageRole;
  content: string;
  providerState?: ProviderState;
}

interface ChatRequest {
  messages: ChatMessage[];
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
}

type FinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'cancelled'
  | 'unknown';

type StreamEvent =
  | {type: 'text_delta'; text: string}
  | {type: 'thinking_delta'; text: string}
  | {type: 'usage'; usage: Usage}
  | {
      type: 'completed';
      finishReason: FinishReason;
      providerState?: ProviderState;
    }
  | {type: 'error'; error: ProviderError};

interface LLMClient {
  streamChat(
    request: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<StreamEvent>;
}

function createLLMClient(profile: ProviderProfile): LLMClient;
```

只有 Provider 工厂根据 `protocol` 分发。上层只消费统一的异步事件。OpenAI Responses 完成事件可携带不透明的可重放 output items；控制器和 TUI 不解析它。

### 错误

```ts
type ProviderErrorCode =
  | 'authentication'
  | 'rate_limit'
  | 'network'
  | 'context_limit'
  | 'invalid_request'
  | 'provider_error'
  | 'unknown';

interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  statusCode?: number;
}
```

错误离开 Provider 前完成分类和 secret redaction。原始请求头、API Key 和可能包含敏感数据的完整响应体不进入该类型。

### 会话和消息

```ts
interface Session {
  id: string;
  profileName: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

type MessageStatus =
  | 'streaming'
  | 'completed'
  | 'cancelled'
  | 'failed';

interface StoredMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  thinking: string;
  status: MessageStatus;
  errorCode: ProviderErrorCode | null;
  errorMessage: string | null;
  usage: Usage | null;
  providerState: ProviderState | null;
  createdAt: number;
  updatedAt: number;
}

interface FinalMessageUpdate {
  content: string;
  thinking: string;
  status: Exclude<MessageStatus, 'streaming'>;
  error: ProviderError | null;
  usage: Usage | null;
  providerState: ProviderState | null;
}
```

ID 使用 `crypto.randomUUID()`；时间保存为 Unix 毫秒。会话标题由第一条用户消息在本地截取生成。

### TUI 状态

```ts
type Screen =
  | 'profile_select'
  | 'chat'
  | 'session_list'
  | 'terminal_too_small';

type RequestStatus =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'cancelling'
  | 'failed';

interface AppState {
  screen: Screen;
  profile: ProfileSummary | null;
  session: Session | null;
  messages: StoredMessage[];
  requestStatus: RequestStatus;
  latestUsage: Usage | null;
  expandedThinkingIds: Set<string>;
  selectedMessageId: string | null;
  visibleError: string | null;
}
```

输入草稿和滚动位置是 TUI 局部状态，不进入 `AppState` 或 SQLite。

### SQLite schema

```text
schema_migrations
  version INTEGER PRIMARY KEY
  applied_at INTEGER NOT NULL

sessions
  id TEXT PRIMARY KEY
  profile_name TEXT NOT NULL
  title TEXT NOT NULL
  created_at INTEGER NOT NULL
  updated_at INTEGER NOT NULL

messages
  id TEXT PRIMARY KEY
  session_id TEXT NOT NULL REFERENCES sessions(id)
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant'))
  content TEXT NOT NULL
  thinking TEXT NOT NULL
  status TEXT NOT NULL CHECK(status IN ('streaming', 'completed', 'cancelled', 'failed'))
  error_code TEXT NULL
  error_message TEXT NULL
  input_tokens INTEGER NULL
  output_tokens INTEGER NULL
  provider_state TEXT NULL
  created_at INTEGER NOT NULL
  updated_at INTEGER NOT NULL
```

索引：

- `sessions(profile_name, updated_at DESC)`：恢复和列出指定 profile 的会话。
- `messages(session_id, created_at ASC)`：按顺序恢复消息。

SQLite 不保存 profile、`base_url` 或 API Key。`provider_state` 仅保存 OpenAI Responses 的可重放 output items JSON。

## 模块设计

### CLI 与启动模块

**职责：**

- 解析 `--profile`、`--help`。
- 检查 Node.js 和交互终端前置条件。
- 初始化配置、存储、Provider、控制器和 Ink。
- 协调正常退出及未捕获异常清理。

**接口：**

```ts
interface CliOptions {
  profile?: string;
  help: boolean;
}

function parseCliArgs(argv: string[]): CliOptions;
async function bootstrap(options: CliOptions): Promise<void>;
```

### 配置模块

**职责：**

- 固定读取 `%USERPROFILE%\.mycode\config.yaml` 和同目录 `.env`。
- 解析 YAML、`${ENV_NAME}` 和 thinking 联合配置。
- 校验 URL、协议、名称唯一性、字段完整性和 thinking 协议约束。
- 提供已解析 profile，并集中执行 secret redaction。

**接口：**

```ts
interface AppConfig {
  profiles: ProviderProfile[];
}

function loadConfig(): AppConfig;
function resolveProfile(
  config: AppConfig,
  requestedName?: string,
): ProviderProfile | null;
function redactSecrets(
  value: string,
  profiles: ProviderProfile[],
): string;
```

多个 profile 且无 `--profile` 时返回 `null`，由 TUI 选择，不视为错误。

### Provider 模块

**职责：**

- 定义供应商无关的数据结构和 `LLMClient`。
- 使用官方 Node.js SDK发起流式请求。
- 将历史消息转换为协议输入，将 SDK 事件转换为 `StreamEvent`。
- 传递取消信号，归一化用量、完成原因和错误。
- 在 Anthropic 内执行已批准的 thinking 兼容策略。

**实现：**

```text
AnthropicClient
OpenAIResponsesClient
OpenAIChatClient
LLMClientFactory
```

OpenAI Responses 和 Chat Completions 使用独立适配器，不共享协议分支。三个实现都不读取 SQLite 或 TUI 状态。

### 对话控制模块

**职责：**

- 维护唯一应用状态和状态订阅。
- 恢复、新建、列出及切换会话。
- 原子开始一个 turn，构建历史并消费流事件。
- 管理当前 `AbortController`、检查点、完成、取消和失败。
- 阻止并发请求和生成期间的会话切换。

**接口：**

```ts
type StateListener = (state: AppState) => void;

interface ChatController {
  getState(): AppState;
  subscribe(listener: StateListener): () => void;
  initialize(profile: ProviderProfile): Promise<void>;
  sendMessage(text: string): Promise<void>;
  cancelActiveRequest(): Promise<void>;
  createSession(): Promise<void>;
  listSessions(): Promise<Session[]>;
  switchSession(sessionId: string): Promise<void>;
  shutdown(): Promise<void>;
}
```

### 会话存储模块

**职责：**

- 对外提供异步领域接口。
- 通过 Worker RPC执行迁移、事务和查询。
- 验证 Worker 返回数据并将数据库错误转换为存储错误。

**接口：**

```ts
interface BeginTurnResult {
  userMessage: StoredMessage;
  assistantMessage: StoredMessage;
}

interface SessionRepository {
  initialize(): Promise<void>;
  findLatestSession(profileName: string): Promise<Session | null>;
  listSessions(profileName: string): Promise<Session[]>;
  createSession(profileName: string): Promise<Session>;
  getSession(sessionId: string): Promise<Session | null>;
  getMessages(sessionId: string): Promise<StoredMessage[]>;
  beginTurn(sessionId: string, text: string): Promise<BeginTurnResult>;
  checkpointAssistant(
    messageId: string,
    content: string,
    thinking: string,
  ): Promise<void>;
  finalizeMessage(
    messageId: string,
    update: FinalMessageUpdate,
  ): Promise<void>;
  close(): Promise<void>;
}
```

`beginTurn` 在一个事务内写入用户消息、assistant draft、会话更新时间和首条消息标题。

### 存储 Worker

**职责：**

- 独占 Node.js `node:sqlite` 的同步连接；同步操作仅发生在 Worker 内。
- 按请求 ID 接收和响应结构化 RPC。
- 顺序执行写入并运行迁移。
- 退出前清空写入队列并关闭连接。

```ts
interface StorageRequest {
  requestId: string;
  operation: StorageOperation;
  payload: unknown;
}

interface StorageResponse {
  requestId: string;
  result?: unknown;
  error?: SerializedStorageError;
}
```

只有 Worker 可以导入 `node:sqlite`；控制器只依赖 `SessionRepository`。

### Ink TUI

**页面：**

- `ProfileSelectScreen`
- `ChatScreen`
- `SessionListOverlay`
- `TerminalTooSmallScreen`

**组件：**

- `MessageList`
- `Message`
- `ThinkingBlock`
- `PromptInput`
- `SessionList`
- `StatusBar`
- `ErrorBanner`

TUI 使用 Ink 渲染 `AppState`，将键盘输入转换为控制器方法调用。它不读取配置文件、不执行 SQL、不使用 SDK。

### 终端生命周期

**职责：**

- 以 Ink `alternateScreen` 模式渲染。
- 禁用 Ink 默认 `Ctrl+C` 退出，交由控制器判断取消或退出。
- 统一卸载 Ink、停止控制器和关闭 Worker。
- 使正常、错误和重复清理路径幂等。

```ts
type ShutdownReason = 'user' | 'fatal_error';
async function shutdownOnce(reason: ShutdownReason): Promise<void>;
```

## 模块交互

### 启动

```text
parseCliArgs
  -> loadConfig
  -> initialize SessionRepository / migrations
  -> render Ink alternate screen
  -> resolve or select profile
  -> createLLMClient
  -> ChatController.initialize
  -> restore latest profile session or create one
  -> ChatScreen
```

配置错误发生在全屏启动前。数据库或 TUI 初始化失败时先恢复终端，再输出清理后的错误并以非零状态退出。

### 发送和流式更新

1. TUI 在空闲状态调用 `sendMessage(text)`。
2. 控制器拒绝空白输入和并发请求。
3. `beginTurn` 在一个事务中创建用户消息与 streaming assistant 消息。
4. 控制器从当前会话构建 `ChatRequest`：
   - 包含所有用户消息。
   - 包含 completed assistant 消息。
   - 包含有文本内容的 cancelled assistant 消息。
   - 排除 failed assistant 消息。
   - 不把 thinking 展示文本混入普通消息。
5. Provider 开始异步流并接收 `AbortSignal`。
6. 每个 delta 立即更新内存和 Ink；文本变化最多每 200ms 合并写入检查点。
7. `completed`、用户取消或错误都使用当时的完整数据调用 `finalizeMessage`，不依赖最后一次检查点。
8. 控制器回到 `idle` 或可继续操作的 `failed` 状态。

同一时间只允许一个未完成的检查点写入。Worker 仍忙时，新 delta 合并进下一次写入，避免队列无限增长。

### Anthropic thinking

- 未配置或 `false`：不发送 thinking。
- 显式 adaptive：只发送 adaptive，不自动回退。
- 显式 manual：发送用户指定的 `budgetTokens/maxTokens`。
- `true`：先发送 adaptive；仅在没有产生任何事件且供应商明确返回 adaptive 不受支持的 400 参数错误时，以 `4096/8192` 重试 manual。
- 认证、限流、网络、普通参数错误或已经产生流事件的请求不重试。

### OpenAI Responses 历史

Responses 请求设置 `store: false`。完成时保存 SDK 规范化后的可重放 output items 到 `provider_state`。下一轮按原顺序将 user input 和这些 items 组合为请求。取消消息或没有合法 provider state 时使用普通 assistant 文本。损坏或协议不匹配的 state 降级为文本并显示非致命警告。

### 取消

生成时按 `Ctrl+C`：

1. 状态改为 `cancelling`。
2. 当前 `AbortController.abort()`。
3. 等待 Provider 流结束。
4. 由用户触发的 abort 始终完成为 `cancelled`，不显示供应商错误。
5. 完整部分文本、thinking 和状态写入 SQLite。
6. 返回 `idle`，保留当前界面和会话。

重复 `Ctrl+C` 不执行第二次取消，也不强制退出。

### 失败

Provider 错误被归一化并清理后交给控制器。assistant 消息以 `failed` 结束，当前会话保持可用；失败消息保存在历史中供查看，但不进入下一次模型上下文。

### 会话操作

- 列表只显示当前 profile 的会话，按 `updatedAt` 倒序。
- 生成或取消收尾期间禁止新建和切换。
- 新会话继承当前 profile。
- 切换时清空瞬时错误、用量和展开选择状态，再加载目标消息。
- 输入草稿不持久化。

### 退出

空闲时按 `Ctrl+C`：停止接受新操作，等待最后存储写入，关闭 Worker，卸载 Ink并恢复备用屏幕，退出码为 0。未捕获异常复用同一幂等流程并以非零状态退出。

强制终止无法运行清理时，WAL 和已提交事务保证数据库可重新打开；最多丢失尚未进入最近一次 200ms 检查点的流式片段。

## 文件组织

```text
Coding_agent/
├── package.json
├── package-lock.json
├── tsconfig.json
├── eslint.config.js
├── vitest.config.ts
├── .gitignore
├── README.md
├── Claude.md
├── spec.md
├── plan.md
├── task.md
├── checklist.md
├── examples/
│   ├── config.example.yaml
│   └── .env.example
├── src/
│   ├── bin/mycode.ts
│   ├── cli/
│   │   ├── args.ts
│   │   └── bootstrap.ts
│   ├── config/
│   │   ├── types.ts
│   │   ├── schema.ts
│   │   ├── loader.ts
│   │   └── secrets.ts
│   ├── providers/
│   │   ├── types.ts
│   │   ├── factory.ts
│   │   ├── errors.ts
│   │   ├── anthropic.ts
│   │   ├── openai-responses.ts
│   │   └── openai-chat.ts
│   ├── chat/
│   │   ├── controller.ts
│   │   ├── context.ts
│   │   └── state.ts
│   ├── storage/
│   │   ├── types.ts
│   │   ├── repository.ts
│   │   ├── worker-client.ts
│   │   ├── worker-protocol.ts
│   │   ├── worker.ts
│   │   └── migrations/
│   │       ├── index.ts
│   │       └── 001-initial.ts
│   ├── tui/
│   │   ├── app.tsx
│   │   ├── render.tsx
│   │   ├── keys.ts
│   │   ├── hooks/use-chat-controller.ts
│   │   ├── screens/
│   │   │   ├── profile-select-screen.tsx
│   │   │   ├── chat-screen.tsx
│   │   │   └── terminal-too-small-screen.tsx
│   │   └── components/
│   │       ├── message-list.tsx
│   │       ├── message.tsx
│   │       ├── thinking-block.tsx
│   │       ├── prompt-input.tsx
│   │       ├── session-list.tsx
│   │       ├── status-bar.tsx
│   │       └── error-banner.tsx
│   ├── terminal/
│   │   ├── session.ts
│   │   └── shutdown.ts
│   └── shared/
│       ├── errors.ts
│       └── ids.ts
└── tests/
    ├── unit/
    │   ├── cli/
    │   ├── config/
    │   ├── providers/
    │   ├── chat/
    │   └── storage/
    ├── integration/
    │   ├── chat-controller.test.ts
    │   ├── provider-streaming.test.ts
    │   └── storage-worker.test.ts
    ├── tui/
    │   ├── app.test.tsx
    │   ├── chat-screen.test.tsx
    │   └── keyboard.test.tsx
    ├── helpers/
    │   ├── mock-llm-client.ts
    │   ├── mock-sse-server.ts
    │   └── temporary-home.ts
    └── fixtures/
        ├── configs/
        └── streams/
```

`src/bin/mycode.ts` 是唯一入口。`src/providers/types.ts` 是上层可引用的 Provider 类型入口。`src/storage/worker.ts` 是唯一导入 `node:sqlite` 的文件。迁移用 TypeScript 导出 SQL 字符串，避免构建时漏拷贝资源。

`Claude.md` 同步改为 MyCode、Windows Terminal 和纯对话阶段，删除 tmux 与 tool use 冲突描述。`dist/`、`.env`、数据库和测试临时目录加入 `.gitignore`。

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| Node.js | 24 LTS，`engines >=24 <25` | 当前 LTS；不追随 Current 版本 |
| 语言 | TypeScript strict | 完整检查联合事件和状态机 |
| 模块 | 原生 ESM、`NodeNext` | 匹配当前 Ink 和 SDK |
| 包管理 | npm + lockfile | 降低环境要求并锁定依赖 |
| 开发运行 | `tsx` | 直接运行 TS/TSX |
| 构建 | `tsc` 输出 `dist/` | 生成 Node 可运行的 JS 和 Worker 文件 |
| TUI | Ink 7 + React 19.2+ | 提供 alternate screen、窗口尺寸、粘贴和 CJK 修复 |
| Provider | OpenAI、Anthropic 官方 Node.js SDK | 由适配器统一流事件 |
| SQLite | Node 24 `node:sqlite` + Worker Thread | 避免 Windows 原生扩展编译依赖；同步 API 由 Worker 隔离，不阻塞主线程 |
| 验证 | Zod | 同一 schema 负责运行时配置和 RPC 边界 |
| YAML/.env | `yaml` + `dotenv.parse` | 不污染全局 `process.env` |
| 测试 | Vitest + ink-testing-library | 支持 TS、组件和异步流测试 |
| 代码质量 | ESLint + typescript-eslint + React Hooks | 覆盖 TS 和 Ink hooks 规则 |

### Ink 运行选项和键位

```ts
render(<App />, {
  alternateScreen: true,
  exitOnCtrlC: false,
  patchConsole: false,
});
```

最小终端尺寸为 60×16。多行粘贴保留；首版不实现键盘手动插入换行。

| 键位 | 行为 |
|---|---|
| Enter | 发送输入；消息焦点时切换 thinking |
| Ctrl+C | 生成时取消；空闲时退出 |
| Ctrl+N | 新建会话 |
| Ctrl+O | 打开会话列表 |
| PageUp/PageDown | 滚动消息 |
| Tab | 切换输入区/消息区焦点 |
| 消息区 Up/Down | 选择消息 |
| Esc | 关闭弹层 |

### 配置文件

```yaml
profiles:
  - name: claude-main
    protocol: anthropic
    model: claude-model-id
    base_url: https://api.anthropic.com
    api_key: ${ANTHROPIC_API_KEY}
    thinking: true

  - name: openai-new
    protocol: openai-responses
    model: model-id
    base_url: https://api.openai.com/v1
    api_key: ${OPENAI_API_KEY}
    thinking: false

  - name: compatible-chat
    protocol: openai-chat
    model: model-id
    base_url: https://example.com/v1
    api_key: ${COMPATIBLE_API_KEY}
```

`api_key` 必须完整匹配 `${ENV_NAME}`。`base_url` 只允许 HTTP(S)。thinking 只允许 Anthropic；manual 要求 `budget_tokens >= 1024` 且小于 `max_tokens`。

### Provider 请求

- 三种实现使用配置 `baseURL` 和 `AbortSignal`。
- 关闭 SDK 自动重试，避免不可见的重复请求。
- OpenAI Responses 设置 `store: false` 并保存本地 replay state。
- OpenAI Chat 为兼容第三方服务，只发送 `model`、`messages`、`stream` 等常见字段，不强制发送 `store` 或其他扩展字段。
- Anthropic 使用 Messages streaming API。
- 缺失用量时不估算 token。

### SQLite

数据库固定为 `%USERPROFILE%\.mycode\mycode.db`。Worker 打开连接后设置：

```text
journal_mode=WAL
foreign_keys=ON
synchronous=FULL
busy_timeout=5000
```

迁移、`beginTurn` 和 `finalizeMessage` 使用事务。主线程永不直接执行 SQL。

### 安全

- 不写持久日志。
- API Key 只存在于配置解析结果和 SDK 客户端内存。
- YAML、SQLite、错误和测试快照不得包含真实密钥。
- 除选定模型 API 外没有遥测或附加网络请求。
- OpenAI provider state 不保存认证信息。

### 脚本和测试

```text
npm run dev
npm run build
npm run start
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm run check
```

`npm run check` 依次执行 typecheck、lint、测试和构建。

测试分层：

1. 单元测试配置、secret redaction、事件映射、上下文和状态转换。
2. 临时 SQLite 测试迁移、事务、Worker RPC 和异常恢复。
3. 本地 SSE 服务器测试三种协议的分块、错误、用量和取消。
4. Ink 测试模拟输入、粘贴、窗口变化、焦点和快捷键。
5. 控制器集成测试完整发送、检查点、完成、失败、取消和会话切换。
6. Windows Terminal 中使用有效配置执行真实端到端验收。

## 需求覆盖

| Spec 需求 | 架构归属 |
|---|---|
| F1 | Ink TUI、终端生命周期 |
| F2 | 配置模块的固定路径加载 |
| F3 | 配置 schema、thinking schema、ProviderProfile |
| F4 | CLI profile 解析、ProfileSelectScreen |
| F5 | 配置校验、secret redaction、启动错误处理 |
| F6 | ChatController 初始化、SessionRepository 最近会话查询 |
| F7 | ChatController 会话方法、会话列表 TUI |
| F8 | 统一 StreamEvent、ChatController 流消费 |
| F9 | 三个 Provider 适配器、统一错误和完成事件 |
| F10 | AnthropicClient、ThinkingBlock、thinking 配置 schema |
| F11 | context builder、Provider 输入适配 |
| F12 | SQLite Worker、SessionRepository 事务和检查点 |
| F13 | 消息恢复、ThinkingBlock 默认折叠状态 |
| F14 | ChatController、AbortController、cancelled finalize |
| F15 | shutdownOnce、存储 flush、Ink 卸载 |
| F16 | Provider 错误映射、控制器失败收尾、ErrorBanner |
| F17 | Usage 事件、AppState、StatusBar |
| F18 | LLMClient、Provider 工厂、独立协议适配器 |

所有 F 需求均有明确架构归属。模块依赖由 TUI/CLI 指向应用接口，再指向 Provider 和存储接口，不存在 Provider、存储或 TUI 之间的循环依赖。
