# MyCode Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 新建 | `package.json`, `package-lock.json` | 依赖、脚本、Node 版本和 `MyCode` bin |
| 新建 | `tsconfig.json`, `eslint.config.js`, `vitest.config.ts` | 编译、lint 和测试配置 |
| 新建 | `.gitignore` | 排除构建产物、密钥、数据库和测试临时文件 |
| 新建 | `README.md` | 安装、配置、构建、运行和快捷键说明 |
| 修改 | `Claude.md` | 同步 MyCode、Windows Terminal 和纯对话阶段约束 |
| 新建 | `examples/config.example.yaml`, `examples/.env.example` | 不含真实密钥的配置模板 |
| 新建 | `src/bin/mycode.ts` | 唯一命令入口 |
| 新建 | `src/cli/args.ts`, `src/cli/bootstrap.ts` | 参数解析和启动编排 |
| 新建 | `src/config/types.ts`, `src/config/schema.ts`, `src/config/loader.ts`, `src/config/secrets.ts` | 配置类型、校验、固定路径加载和密钥清理 |
| 新建 | `src/providers/types.ts`, `src/providers/factory.ts`, `src/providers/errors.ts` | Provider 公共协议、工厂和错误归一化 |
| 新建 | `src/providers/anthropic.ts`, `src/providers/openai-responses.ts`, `src/providers/openai-chat.ts` | 三种官方 SDK 适配器 |
| 新建 | `src/chat/controller.ts`, `src/chat/context.ts`, `src/chat/state.ts` | 对话状态、上下文和流式编排 |
| 新建 | `src/storage/types.ts`, `src/storage/repository.ts` | 存储领域类型和异步 repository |
| 新建 | `src/storage/worker-client.ts`, `src/storage/worker-protocol.ts`, `src/storage/worker.ts` | SQLite Worker RPC 和数据库操作 |
| 新建 | `src/storage/migrations/index.ts`, `src/storage/migrations/001-initial.ts` | 迁移注册和初始 schema |
| 新建 | `src/tui/app.tsx`, `src/tui/render.tsx`, `src/tui/keys.ts` | TUI 根组件、Ink 启动和键位 |
| 新建 | `src/tui/hooks/use-chat-controller.ts` | 将控制器订阅接入 React |
| 新建 | `src/tui/screens/profile-select-screen.tsx`, `src/tui/screens/chat-screen.tsx`, `src/tui/screens/terminal-too-small-screen.tsx` | 主要页面 |
| 新建 | `src/tui/components/message-list.tsx`, `src/tui/components/message.tsx`, `src/tui/components/thinking-block.tsx` | 消息、滚动和思考展示 |
| 新建 | `src/tui/components/prompt-input.tsx`, `src/tui/components/session-list.tsx`, `src/tui/components/status-bar.tsx`, `src/tui/components/error-banner.tsx` | 输入、会话列表、状态和错误组件 |
| 新建 | `src/terminal/session.ts`, `src/terminal/shutdown.ts` | Ink 实例和幂等清理生命周期 |
| 新建 | `src/shared/errors.ts`, `src/shared/ids.ts` | 通用错误与 ID/时间辅助函数 |
| 新建 | `tests/unit/cli/args.test.ts` | CLI 参数测试 |
| 新建 | `tests/unit/config/schema.test.ts`, `tests/unit/config/loader.test.ts`, `tests/unit/config/secrets.test.ts` | 配置测试 |
| 新建 | `tests/unit/providers/errors.test.ts`, `tests/unit/providers/factory.test.ts`, `tests/unit/providers/openai-chat.test.ts`, `tests/unit/providers/openai-responses.test.ts`, `tests/unit/providers/anthropic.test.ts` | Provider 单元测试 |
| 新建 | `tests/unit/chat/context.test.ts`, `tests/unit/chat/state.test.ts` | 上下文和状态测试 |
| 新建 | `tests/unit/storage/migrations.test.ts`, `tests/unit/storage/repository.test.ts` | 存储单元测试 |
| 新建 | `tests/integration/chat-controller.test.ts`, `tests/integration/provider-streaming.test.ts`, `tests/integration/storage-worker.test.ts` | 核心集成测试 |
| 新建 | `tests/tui/app.test.tsx`, `tests/tui/chat-screen.test.tsx`, `tests/tui/keyboard.test.tsx` | TUI 渲染与键盘测试 |
| 新建 | `tests/helpers/mock-llm-client.ts`, `tests/helpers/mock-sse-server.ts`, `tests/helpers/mock-sse-server.test.ts`, `tests/helpers/temporary-home.ts` | 测试替身、SSE helper 自检和临时用户目录 |
| 新建 | `tests/fixtures/configs/valid.yaml`, `tests/fixtures/configs/invalid.yaml` | 配置样例 |
| 新建 | `tests/fixtures/streams/anthropic.txt`, `tests/fixtures/streams/openai-responses.txt`, `tests/fixtures/streams/openai-chat.txt` | 三种 SSE 事件样例 |

## T1：建立 npm 项目和依赖基线

**文件：**

- `package.json`
- `package-lock.json`

**依赖：** 无

**步骤：**

1. 创建 ESM package，设置 `engines.node` 为 `>=24 <25`，注册 `MyCode` bin 到 `dist/bin/mycode.js`。
2. 添加 plan 指定的运行依赖和开发依赖。
3. 添加 `dev`、`build`、`start`、`typecheck`、`lint`、`test`、`test:coverage` 和 `check` 脚本。
4. 运行 npm 安装并生成 lockfile，不加入未在 plan 中使用的框架。

**验证：** 运行 `npm install`，期望退出码 0 且生成 `package-lock.json`；运行 `npm exec tsc -- --version`，期望显示 TypeScript 版本。

## T2：配置 TypeScript、Vitest、ESLint 和忽略规则

**文件：**

- `tsconfig.json`
- `vitest.config.ts`
- `eslint.config.js`
- `.gitignore`
- `src/shared/ids.ts`
- `src/shared/errors.ts`

**依赖：** T1

**步骤：**

1. 配置 `NodeNext`、strict、TSX、`src` 到 `dist` 的编译规则，并包含测试的类型检查。
2. 配置 Vitest 的 Node 环境、测试路径、覆盖率和单线程可控选项。
3. 配置 TypeScript 与 React Hooks lint 规则。
4. 忽略 `dist`、`node_modules`、`.env`、SQLite/WAL 文件、coverage 和测试临时目录。
5. 实现基于 `crypto.randomUUID()` 的 ID 和 Unix 毫秒时间辅助函数，以及通用错误基类。

**验证：** 运行 `npm run typecheck` 和 `npm run lint`，期望两者退出码均为 0。

## T3：定义并校验配置模型

**文件：**

- `src/config/types.ts`
- `src/config/schema.ts`

**依赖：** T2

**步骤：**

1. 定义三种 `Protocol`、source/runtime profile 和 thinking 联合类型。
2. 用 Zod 建立 `profiles` 顶层 schema，校验必填字段、名称唯一性、HTTP(S) URL 和 `${ENV_NAME}` 完整引用。
3. 限制 thinking 只能用于 Anthropic；manual 校验 `budget_tokens >= 1024` 且小于 `max_tokens`。
4. 将 `true` 归一化为 auto、`false` 或缺省归一化为 disabled。

**验证：** 运行 `npm run typecheck`，期望退出码 0，且 schema 的推导类型可赋值给配置 source 类型。

## T4：实现固定路径配置加载和密钥清理

**文件：**

- `src/config/loader.ts`
- `src/config/secrets.ts`

**依赖：** T3

**步骤：**

1. 使用 `os.homedir()` 定位 `.mycode/config.yaml` 和 `.mycode/.env`，不搜索其他路径。
2. 使用 `yaml` 和 `dotenv.parse()` 读取内容，不修改 `process.env`。
3. 解析每个 `api_key` 引用并生成 runtime profile；缺失变量时给出不含密钥的错误。
4. 实现 `resolveProfile()` 的单 profile、指定 profile、多 profile 待选择和未知 profile 行为。
5. 实现对全部已解析密钥的字符串 redaction。

**验证：** 运行 `npm run typecheck`，期望退出码 0；用无效临时路径调用 loader 时，错误只包含配置路径，不包含任何环境变量值。

## T5：覆盖配置边界测试

**文件：**

- `tests/helpers/temporary-home.ts`
- `tests/fixtures/configs/valid.yaml`
- `tests/fixtures/configs/invalid.yaml`
- `tests/unit/config/schema.test.ts`
- `tests/unit/config/loader.test.ts`
- `tests/unit/config/secrets.test.ts`

**依赖：** T4

**步骤：**

1. 建立自动清理的临时 home 和固定 `.mycode` 文件辅助函数。
2. 覆盖三个协议、thinking 四种形式和多 profile 正常加载。
3. 覆盖 YAML/.env 缺失、重复名称、未知协议、无效 URL、无效 key 引用、未知 profile 和非法 thinking。
4. 断言所有失败输出均不包含测试密钥。

**验证：** 运行 `npm test -- tests/unit/config`，期望全部配置测试通过且退出码 0。

## T6：建立 Provider 公共协议、错误映射和工厂

**文件：**

- `src/providers/types.ts`
- `src/providers/errors.ts`
- `src/providers/factory.ts`
- `tests/unit/providers/errors.test.ts`
- `tests/unit/providers/factory.test.ts`

**依赖：** T3

**步骤：**

1. 实现 `ChatMessage`、`ProviderState`、`Usage`、`StreamEvent`、`ProviderError` 和 `LLMClient`。
2. 实现供应商错误到统一 code、status 和 retryable 的映射，并调用 secret redaction。
3. 工厂只按三个 protocol 创建对应客户端；未知协议走穷尽检查。
4. 测试错误映射、终止事件类型和工厂分发，不导出 SDK 类型。

**验证：** 运行 `npm test -- tests/unit/providers/errors.test.ts tests/unit/providers/factory.test.ts`，期望全部通过；运行 `npm run typecheck`，期望穷尽检查无错误。

## T7：实现 OpenAI Chat Completions 适配器

**文件：**

- `src/providers/openai-chat.ts`
- `tests/unit/providers/openai-chat.test.ts`

**依赖：** T6

**步骤：**

1. 用官方 OpenAI SDK、配置的 `baseURL` 和关闭的自动重试创建客户端。
2. 将通用历史转换为 `messages`，只发送兼容性所需的常见字段和 `stream: true`。
3. 将 `choices[].delta.content`、finish reason 和可用 usage 转换为统一事件。
4. 传递 `AbortSignal`，区分用户 abort 与真实错误。
5. 用 SDK 流替身验证文本分块、完成、用量、空 delta 和错误。

**验证：** 运行 `npm test -- tests/unit/providers/openai-chat.test.ts`，期望流事件顺序与 fixture 断言全部通过。

## T8：实现 OpenAI Responses 适配器和 replay state

**文件：**

- `src/providers/openai-responses.ts`
- `tests/unit/providers/openai-responses.test.ts`

**依赖：** T6

**步骤：**

1. 用官方 SDK 创建 Responses 流，请求固定设置 `store: false` 并传递 abort。
2. 将通用用户/assistant 文本及匹配协议的 provider state 按原顺序转换为 input items。
3. 将 typed SSE 文本、完成、错误和 usage 转为统一事件。
4. 从完成 response 生成可序列化、可重放的 `ProviderState`。
5. provider state 损坏或协议不匹配时退回 assistant 文本，并返回可展示的非致命警告路径。
6. 测试 reasoning/output items 保留、纯文本回退和 `store: false`。

**验证：** 运行 `npm test -- tests/unit/providers/openai-responses.test.ts`，期望 replay 顺序、文本流和错误路径全部通过。

## T9：实现 Anthropic 适配器和 thinking 兼容

**文件：**

- `src/providers/anthropic.ts`
- `tests/unit/providers/anthropic.test.ts`

**依赖：** T6

**步骤：**

1. 用官方 Anthropic SDK、配置的 `baseURL` 和关闭的自动重试创建 Messages 流。
2. 转换通用历史、文本 delta、thinking delta、usage、完成和错误。
3. 实现 disabled、adaptive、manual 和 auto thinking。
4. auto 仅在无事件且收到明确“不支持 adaptive”的 400 时以 `4096/8192` 重试 manual。
5. 验证认证、限流、网络错误以及已经输出 delta 的请求绝不回退。

**验证：** 运行 `npm test -- tests/unit/providers/anthropic.test.ts`，期望四种 thinking 模式、精确回退条件和事件转换全部通过。

## T10：建立本地 SSE 测试服务器和流 fixture

**文件：**

- `tests/helpers/mock-sse-server.ts`
- `tests/helpers/mock-sse-server.test.ts`
- `tests/fixtures/streams/anthropic.txt`
- `tests/fixtures/streams/openai-responses.txt`
- `tests/fixtures/streams/openai-chat.txt`

**依赖：** T2

**步骤：**

1. 用 Node HTTP server 建立可绑定随机本地端口的测试辅助函数。
2. 支持按给定延迟发送 SSE 帧、主动断开、返回任意状态和记录请求 body/header。
3. 创建三种官方 SDK 能解析的最小文本、用量和完成事件序列。
4. 确保 server 在测试结束时关闭全部 socket，不残留句柄。

**验证：** 运行 `npm test -- tests/helpers/mock-sse-server.test.ts`，期望 server 可启动、发送至少两个分块并在关闭后释放端口。

## T11：验证三种真实 SDK 流式集成

**文件：**

- `tests/integration/provider-streaming.test.ts`

**依赖：** T7、T8、T9、T10

**步骤：**

1. 将三个 Provider 的 `baseURL` 指向本地 SSE server。
2. 分别验证请求在完成前产生多次文本更新、最终文本一致、usage 正确。
3. 验证 `AbortSignal` 停止连接且不会继续产生 delta。
4. 验证认证、限流、网络断开和不合法事件被统一分类。
5. 断言请求和错误快照不含真实或测试密钥明文。

**验证：** 运行 `npm test -- tests/integration/provider-streaming.test.ts`，期望三协议、取消和错误用例全部通过且 Vitest 无 open-handle 警告。

## T12：定义存储类型、初始迁移和约束

**文件：**

- `src/storage/types.ts`
- `src/storage/migrations/001-initial.ts`
- `src/storage/migrations/index.ts`
- `tests/unit/storage/migrations.test.ts`

**依赖：** T2、T6

**步骤：**

1. 定义 `Session`、`StoredMessage`、`FinalMessageUpdate` 和 repository 输入输出类型。
2. 编写 migrations、sessions、messages 表及两个索引的 SQL。
3. 加入 role/status CHECK、外键、非空和迁移版本约束。
4. 实现按版本顺序执行且不可重复应用的迁移注册器。
5. 用内存数据库验证 schema、约束和重复迁移。

**验证：** 运行 `npm test -- tests/unit/storage/migrations.test.ts`，期望 schema、索引和约束断言全部通过。

## T13：实现 Worker RPC 协议和主线程客户端

**文件：**

- `src/storage/worker-protocol.ts`
- `src/storage/worker-client.ts`

**依赖：** T12

**步骤：**

1. 定义所有存储 operation 的判别联合、payload 和 response schema。
2. 实现请求 ID、pending Promise、Worker 消息和错误反序列化。
3. 处理 Worker 提前退出、未知 request ID、关闭后请求和幂等 close。
4. Worker URL 使用 `import.meta.url` 指向编译后的 `worker.js`。

**验证：** 运行 `npm run typecheck`，期望 operation switch 穷尽且 Worker 路径编译为合法 ESM。

## T14：实现 SQLite Worker 数据库操作

**文件：**

- `src/storage/worker.ts`

**依赖：** T12、T13

**步骤：**

1. 在 Worker 内独占打开 Node 24 `node:sqlite`，设置 WAL、foreign keys、FULL synchronous 和 busy timeout。
2. 实现迁移、创建/查询会话、列出会话、加载消息。
3. 以事务实现 `beginTurn` 和 `finalizeMessage`，实现轻量 checkpoint。
4. 对 provider state 做 JSON 序列化/反序列化和结构验证。
5. 顺序响应 RPC，关闭时拒绝新写入并释放数据库连接。

**验证：** 运行 `npm run typecheck` 和 `npm run build`，期望退出码 0 且生成 `dist/storage/worker.js`。

## T15：实现 SessionRepository

**文件：**

- `src/storage/repository.ts`

**依赖：** T14

**步骤：**

1. 用 `StorageWorkerClient` 实现 plan 中完整的异步 `SessionRepository`。
2. 固定数据库路径为 home 下 `.mycode/mycode.db`，测试允许显式注入临时路径。
3. 验证 RPC 返回值后再映射为领域对象。
4. 将 Worker/SQLite 错误转换为不泄露 SQL 内部或密钥的存储错误。

**验证：** 运行 `npm run typecheck`，期望 repository 完整实现接口且无同步 SQLite 导入。

## T16：覆盖存储 Worker 和 repository 测试

**文件：**

- `tests/unit/storage/repository.test.ts`
- `tests/integration/storage-worker.test.ts`

**依赖：** T15

**步骤：**

1. 使用临时数据库验证 profile 最近会话、排序、新建和消息恢复。
2. 验证 `beginTurn` 原子性、200ms checkpoint 所需更新和 finalize 的完整覆盖。
3. 覆盖 completed/cancelled/failed、usage、thinking 和 provider state 往返。
4. 模拟 Worker 关闭和异常退出，验证已提交数据可在新连接读取。
5. 检查数据库内容不包含配置 key、base URL 或测试密钥。

**验证：** 运行 `npm test -- tests/unit/storage tests/integration/storage-worker.test.ts`，期望全部通过且测试临时数据库被清理。

## T17：实现聊天状态和上下文构建

**文件：**

- `src/chat/state.ts`
- `src/chat/context.ts`
- `tests/unit/chat/state.test.ts`
- `tests/unit/chat/context.test.ts`

**依赖：** T6、T12

**步骤：**

1. 定义无密钥 `AppState`、screen、request status 和不可变状态更新函数。
2. 按时间顺序构建上下文，包含用户、completed 和有内容的 cancelled assistant。
3. 排除 failed assistant 和 thinking 展示文本。
4. 保留 OpenAI Responses provider state；损坏 state 标记非致命警告并退回文本。
5. 测试所有 message status、选择/展开状态和 profile summary 不含密钥。

**验证：** 运行 `npm test -- tests/unit/chat`，期望状态和上下文测试全部通过。

## T18：实现控制器初始化和会话操作

**文件：**

- `src/chat/controller.ts`

**依赖：** T15、T17

**步骤：**

1. 实现状态获取、订阅和仅在变化时通知 listener。
2. 初始化时恢复 profile 最近会话，不存在则创建。
3. 实现列出、新建、切换会话及 profile 隔离。
4. 生成或取消期间拒绝新建/切换并设置用户可见原因。
5. 切换时重置瞬时错误、usage、选择和 thinking 展开集合。

**验证：** 运行 `npm run typecheck`，期望控制器完整实现 session 相关接口且不导入 SDK 或 SQL。

## T19：实现发送、流消费和检查点

**文件：**

- `src/chat/controller.ts`

**依赖：** T11、T18

**步骤：**

1. 拒绝空白输入和并发请求，调用 `beginTurn` 后再发起 Provider 请求。
2. 消费 text、thinking、usage、completed 和 error 事件并立即发布状态。
3. 实现单飞、200ms 合并 checkpoint 调度器。
4. 完成时用内存中的完整内容、usage、finish state 和 provider state finalize。
5. 确保任何终止路径只执行一次 finalize，之后回到可操作状态。

**验证：** 运行 `npm run typecheck`，期望异步流、timer 和终止联合的所有分支通过严格类型检查。

## T20：实现取消、失败和控制器关闭

**文件：**

- `src/chat/controller.ts`

**依赖：** T19

**步骤：**

1. 保存当前 `AbortController` 并实现幂等 `cancelActiveRequest()`。
2. 将用户 abort 统一 finalize 为 cancelled，保留当前文本/thinking。
3. 将 Provider error finalize 为 failed，并设置清理后的错误横幅。
4. 实现 `shutdown()`：停止新操作、取消活动请求、等待 finalize/checkpoint、关闭 repository。
5. 防止重复取消、重复完成和重复关闭。

**验证：** 运行 `npm run typecheck`，期望退出码 0；静态检查控制器只有一个 active request 和一个 shutdown promise。

## T21：验证完整对话控制流程

**文件：**

- `tests/helpers/mock-llm-client.ts`
- `tests/integration/chat-controller.test.ts`

**依赖：** T16、T20

**步骤：**

1. 建立可暂停、分块、报错和响应 abort 的模拟 `LLMClient`。
2. 覆盖初始化恢复、多轮历史、profile 会话隔离和新建/切换。
3. 覆盖流式即时状态、thinking、usage、检查点合并和完成。
4. 覆盖取消部分回复、失败排除上下文、并发拒绝和 shutdown。
5. 用 fake timer 验证 200ms 检查点，无未清理 timer 或 Promise。

**验证：** 运行 `npm test -- tests/integration/chat-controller.test.ts`，期望所有流程通过且无未处理 rejection。

## T22：建立 TUI 根组件、渲染和控制器 hook

**文件：**

- `src/tui/app.tsx`
- `src/tui/render.tsx`
- `src/tui/hooks/use-chat-controller.ts`

**依赖：** T20

**步骤：**

1. 用 `useSyncExternalStore` 或等价安全模式订阅控制器。
2. App 根据 profile 选择、聊天、会话弹层和终端尺寸路由页面。
3. `render()` 使用 `alternateScreen: true`、`exitOnCtrlC: false`、`patchConsole: false`。
4. 使用 `useWindowSize()` 在小于 60×16 时显示尺寸页面，同时保留退出处理。

**验证：** 运行 `npm run typecheck`，期望 TSX 和 controller hook 无 hooks lint 错误。

## T23：实现输入、状态和错误组件

**文件：**

- `src/tui/components/prompt-input.tsx`
- `src/tui/components/status-bar.tsx`
- `src/tui/components/error-banner.tsx`

**依赖：** T22

**步骤：**

1. 输入组件支持 Unicode 编辑、Enter 发送、空白拒绝和 `usePaste()` 多行粘贴。
2. 请求进行中仍保持输入和滚动响应，但不允许第二次发送。
3. 状态栏显示 profile、model、request status 和可用 usage。
4. 错误横幅换行显示清理后的信息，不输出堆栈或密钥。

**验证：** 运行 `npm run typecheck` 和 `npm run lint`，期望组件通过严格类型和 hooks 规则。

## T24：实现消息、滚动和 thinking 组件

**文件：**

- `src/tui/components/message-list.tsx`
- `src/tui/components/message.tsx`
- `src/tui/components/thinking-block.tsx`

**依赖：** T22

**步骤：**

1. 渲染 user/assistant、streaming/cancelled/failed 状态和原始换行。
2. 基于可用高度计算可见消息窗口，支持 PageUp/PageDown。
3. thinking 生成时展开、完成恢复时折叠，并支持选中后切换。
4. 正确处理中文宽字符、空内容和长代码文本，不引入 Markdown renderer。

**验证：** 运行 `npm run typecheck`，期望组件能接收所有 `StoredMessage` 状态且无未覆盖分支。

## T25：实现 profile 和历史会话界面

**文件：**

- `src/tui/screens/profile-select-screen.tsx`
- `src/tui/components/session-list.tsx`

**依赖：** T4、T22

**步骤：**

1. profile 页面支持上下选择和 Enter 确认，只显示名称、协议和模型。
2. 会话列表按 repository 顺序显示本地标题和更新时间。
3. 支持上下选择、Enter 切换、Esc 关闭和空列表状态。
4. 生成期间打开或切换时显示控制器给出的禁止原因。

**验证：** 运行 `npm run typecheck`，期望页面 props 不包含 API Key 且选择回调类型完整。

## T26：组装聊天页面、键位和小窗口页面

**文件：**

- `src/tui/keys.ts`
- `src/tui/screens/chat-screen.tsx`
- `src/tui/screens/terminal-too-small-screen.tsx`

**依赖：** T23、T24、T25

**步骤：**

1. 用固定状态栏/输入区和弹性消息区组装全屏布局。
2. 实现 Ctrl+C、Ctrl+N、Ctrl+O、Tab、PageUp/PageDown、消息 Up/Down/Enter 和 Esc。
3. 根据焦点激活唯一 `useInput` handler，避免同一按键执行两次。
4. 小窗口页面显示当前/所需尺寸，并始终允许 Ctrl+C。

**验证：** 运行 `npm run typecheck` 和 `npm run lint`，期望退出码均为 0，且所有 plan 键位在 `keys.ts` 有唯一映射。

## T27：覆盖 TUI 渲染和键盘行为

**文件：**

- `tests/tui/app.test.tsx`
- `tests/tui/chat-screen.test.tsx`
- `tests/tui/keyboard.test.tsx`

**依赖：** T21、T26

**步骤：**

1. 用 ink-testing-library 模拟 profile 选择、聊天、会话弹层和小窗口。
2. 验证文本分块更新、中文/代码/多行粘贴和 thinking 展开折叠。
3. 验证全部快捷键、焦点切换和生成时/空闲时 Ctrl+C 的不同效果。
4. 验证 resize 后布局重算且退出不残留活动 hook/timer。

**验证：** 运行 `npm test -- tests/tui`，期望所有渲染快照和键盘断言通过。

## T28：实现 CLI 参数解析

**文件：**

- `src/cli/args.ts`
- `tests/unit/cli/args.test.ts`

**依赖：** T2

**步骤：**

1. 只支持无参数、`--profile <name>` 和 `--help`。
2. 对未知参数、缺失 profile 值和重复冲突参数输出明确用法错误。
3. `--help` 不读取配置、不打开数据库、不进入 Ink。

**验证：** 运行 `npm test -- tests/unit/cli/args.test.ts`，期望合法/非法参数和帮助短路测试全部通过。

## T29：实现终端会话和幂等关闭

**文件：**

- `src/terminal/session.ts`
- `src/terminal/shutdown.ts`

**依赖：** T22

**步骤：**

1. 封装 Ink instance、`waitUntilExit`、unmount 和错误传播。
2. 实现只运行一次的 shutdown promise，按控制器、repository/Worker、Ink 顺序清理。
3. 处理用户退出、启动失败和未捕获异常；错误在备用屏幕恢复后输出。
4. 不手写与 Ink `alternateScreen` 重复的 ANSI 切换。

**验证：** 运行 `npm run typecheck`，期望重复调用 shutdown 返回同一 Promise，且资源接口只允许关闭一次。

## T30：实现 bootstrap 和 MyCode 可执行入口

**文件：**

- `src/cli/bootstrap.ts`
- `src/bin/mycode.ts`

**依赖：** T5、T11、T16、T21、T27、T28、T29

**步骤：**

1. 添加 Node shebang，解析参数并让 help 在任何资源初始化前返回。
2. 正常路径依次加载配置、初始化 repository、渲染 profile 选择或创建 Provider/控制器并进入聊天。
3. 配置错误在普通终端输出；全屏后的 fatal error 使用统一 shutdown。
4. 设置明确退出码，注册但不重复执行未捕获异常清理。
5. 确保 bin 入口无业务逻辑，所有流程由 bootstrap 协调。

**验证：** 运行 `npm run build`，期望生成带 shebang 的 `dist/bin/mycode.js`；运行 `node dist/bin/mycode.js --help`，期望显示用法、退出码 0 且不创建 `.mycode` 数据库。

## T31：完善文档、示例和项目约束

**文件：**

- `README.md`
- `examples/config.example.yaml`
- `examples/.env.example`
- `Claude.md`

**依赖：** T30

**步骤：**

1. README 记录 Node 24、npm install、build、源码运行、注册 `MyCode` 命令和 Windows Terminal 前置条件。
2. 给出三个协议、thinking 布尔/对象形式和 `.env` 引用示例。
3. 记录全部快捷键、固定数据路径、SQLite 会话和本阶段不支持的功能。
4. 修改 `Claude.md` 为 MyCode、中文交流、Windows Terminal/PowerShell 验收和纯对话阶段，移除 tmux/tool use 冲突。
5. 示例只使用占位密钥，说明不得提交真实 `.env`。

**验证：** 运行 `rg -n "tmux|正确调用工具" Claude.md`，期望无匹配；运行 `rg -n "sk-[A-Za-z0-9]{12,}" examples`，期望无匹配；运行 README 中列出的 build/help 命令，期望结果与文档一致。

## T32：执行完整质量门槛并修复回归

**文件：**

- 本任务涉及的全部源码、测试和配置文件（仅修复验证发现的问题）

**依赖：** T30、T31

**步骤：**

1. 运行完整 typecheck、lint、单元/集成/TUI 测试和构建。
2. 修复所有失败并重跑相关最小测试，再重跑完整检查。
3. 扫描源码、fixture、构建产物和临时数据库，确认没有真实 API Key。
4. 运行 `--help`、缺失配置和无效 profile 的 CLI smoke test，确认终端状态正常。
5. 确认测试结束无 open handle、Worker、server、timer 或临时文件残留。

**验证：** 运行 `npm run check`，期望退出码 0；运行 `rg -n "sk-[A-Za-z0-9]|ANTHROPIC_API_KEY=.*[^}]" . -g '!node_modules/**' -g '!.git/**'`，期望仅命中明确的占位示例或不命中。

## 执行顺序

```text
T1 -> T2
      ├─> T3 -> T4 -> T5
      ├─> T6 -> T7 ─┐
      │       -> T8 ├─> T11
      │       -> T9 ┘     │
      ├─> T10 ────────────┘
      ├─> T12 -> T13 -> T14 -> T15 -> T16
      └─> T28

T6 + T12 -> T17
T15 + T17 -> T18 -> T19 -> T20
T16 + T20 -> T21

T20 -> T22
       ├─> T23 ─┐
       ├─> T24 ─┼─> T26 -> T27
       └─> T25 ─┘

T22 -> T29
T5 + T11 + T16 + T21 + T27 + T28 + T29 -> T30
T30 -> T31 -> T32
```

可并行组：

- T7、T8、T9 可在 T6 后并行。
- T10 可与 Provider、配置和存储工作并行。
- T12–T16 存储链可与 T7–T11 Provider 链并行。
- T23、T24、T25 可在 T22 后并行。
- T28 可在 T2 后提前完成。
