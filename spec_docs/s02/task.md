# MyCode 工具系统 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 新建 | `src/tools/types.ts` | 工具、调用、审批、结果、错误和限制契约 |
| 新建 | `src/tools/registry.ts` | 工具注册、去重、查找和定义导出 |
| 新建 | `src/tools/workspace-paths.ts` | 工作区真实路径和链接边界守卫 |
| 新建 | `src/tools/utf8.ts` | 严格 UTF-8 与二进制识别 |
| 新建 | `src/tools/limits.ts` | 字节与匹配数量限制 |
| 新建 | `src/tools/executor.ts` | 固定超时、取消和异常归一化 |
| 新建 | `src/tools/call-assembler.ts` | 流式调用参数组装和校验 |
| 新建 | `src/tools/approval-coordinator.ts` | 逐项审批等待与中断 |
| 新建 | `src/tools/batch-coordinator.ts` | 只读并行和副作用串行调度 |
| 新建 | `src/tools/implementations/read-file.ts` | 读取文本文件 |
| 新建 | `src/tools/implementations/write-file.ts` | 排他创建文本文件 |
| 新建 | `src/tools/implementations/edit-file.ts` | 唯一匹配修改文件 |
| 新建 | `src/tools/implementations/run-command.ts` | PowerShell 命令执行 |
| 新建 | `src/tools/implementations/find-files.ts` | glob 查找文件 |
| 新建 | `src/tools/implementations/search-text.ts` | 普通文本搜索 |
| 新建 | `src/chat/turn-orchestrator.ts` | 单回合两阶段编排 |
| 新建 | `src/storage/migrations/002-tool-calls.ts` | 工具记录数据库迁移 |
| 新建 | `src/tui/components/tool-call-card.tsx` | 单项工具记录展示 |
| 新建 | `src/tui/components/tool-call-list.tsx` | 工具记录列表 |
| 新建 | `src/tui/components/tool-approval-panel.tsx` | 逐项审批交互 |
| 修改 | `src/providers/types.ts` | 统一工具定义、上下文和流事件 |
| 修改 | `src/providers/anthropic.ts` | Anthropic 工具协议适配 |
| 修改 | `src/providers/openai-responses.ts` | Responses 工具协议适配 |
| 修改 | `src/providers/openai-chat.ts` | Chat Completions 工具协议适配 |
| 修改 | `src/chat/controller.ts` | 回合委托、审批、取消与状态发布 |
| 修改 | `src/chat/context.ts` | 消息和工具历史上下文构造 |
| 修改 | `src/chat/state.ts` | 工具记录、审批和请求状态 |
| 修改 | `src/storage/types.ts` | 工具记录与仓储接口 |
| 修改 | `src/storage/migrations/index.ts` | 登记版本 2 迁移 |
| 修改 | `src/storage/repository.ts` | 工具持久化仓储入口 |
| 修改 | `src/storage/worker-protocol.ts` | 工具存储 Worker 协议 |
| 修改 | `src/storage/worker.ts` | 工具 SQL、事务和恢复 |
| 修改 | `src/tui/components/message.tsx` | 在助手消息内展示工具记录 |
| 修改 | `src/tui/components/message-list.tsx` | 关联消息与工具记录 |
| 修改 | `src/tui/components/prompt-input.tsx` | 审批和执行时禁用输入 |
| 修改 | `src/tui/components/status-bar.tsx` | 显示审批与执行状态 |
| 修改 | `src/tui/screens/chat-screen.tsx` | 审批按键、取消和布局 |
| 修改 | `src/cli/bootstrap.ts` | 捕获工作区并组装工具系统 |
| 修改 | `src/shared/ids.ts` | 生成内部工具调用标识 |
| 新建 | `tests/helpers/mock-tool.ts` | 可控工具测试替身 |
| 新建 | `tests/helpers/temporary-workspace.ts` | 隔离临时工作区 |
| 修改 | `tests/helpers/mock-llm-client.ts` | 两阶段请求和工具流测试替身 |
| 新建 | `tests/unit/tools/*.test.ts` | 工具域单元测试 |
| 修改 | `tests/unit/providers/*.test.ts` | 三协议工具适配测试 |
| 新建 | `tests/unit/chat/turn-orchestrator.test.ts` | 单回合编排测试 |
| 修改 | `tests/unit/chat/context.test.ts` | 工具历史上下文测试 |
| 修改 | `tests/unit/storage/{migrations,repository}.test.ts` | 工具迁移与仓储测试 |
| 新建 | `tests/integration/{tool-turn,provider-tool-streaming,tool-persistence}.test.ts` | 工具流程集成测试 |
| 修改 | `tests/integration/chat-controller.test.ts` | 控制器工具回合测试 |
| 新建 | `tests/tui/tool-components.test.tsx` | 工具卡片和审批组件测试 |
| 修改 | `tests/tui/chat-screen.test.tsx` | 审批键盘流程测试 |
| 新建 | `tests/fixtures/streams/*-tools.txt` | 三协议工具流夹具 |
| 修改 | `AGENT.md` | 当前状态和工具边界 |
| 修改 | `README.md` | 用户使用、安全和限制说明 |
| 新建 | `Project_Guide/s02.md` | s02 中文实现导读与验收记录 |

## T1：建立工具核心契约和调用标识

**文件：** `src/tools/types.ts`、`src/shared/ids.ts`

**依赖：** 无

**步骤：**

1. 按 plan 定义 `JsonObject`、`ToolEffect`、`ToolDefinition`、`ToolLimits`、`ToolContext`、`Tool`、调用草稿/调用、审批、错误、结果和工具记录类型。
2. 将 `agent_loop_limit` 纳入 `ToolErrorCode`，并保持结果为可判别联合。
3. 在现有 ID 模块增加 `createToolCallId()`，沿用项目 UUID 约定。
4. 新增注释使用 `[s02]`，修改旧实现时按项目留痕规则处理。

**验证：** 运行 `npx tsc --noEmit --pretty false`；允许因尚未完成的后续模块引用而失败，但期望 `src/tools/types.ts` 和 `src/shared/ids.ts` 本身无语法或类型定义错误。

## T2：实现工具注册中心

**文件：** `src/tools/registry.ts`、`tests/unit/tools/registry.test.ts`、`tests/helpers/mock-tool.ts`

**依赖：** T1

**步骤：**

1. 实现稳定顺序的 `register()`、`get()`、`definitions()` 和 `entries()`。
2. 重复名称立即抛出明确启动错误，未知名称返回 `undefined`。
3. 创建可配置 effect、Schema、解析和执行行为的 `MockTool`。
4. 测试定义导出、顺序、查找、重复名称和新增测试工具只登记一次的行为。

**验证：** 运行 `npx vitest run tests/unit/tools/registry.test.ts`，期望全部通过。

## T3：实现结果限制设施

**文件：** `src/tools/limits.ts`、`tests/unit/tools/limits.test.ts`

**依赖：** T1

**步骤：**

1. 实现按 UTF-8 字节安全截断的 `truncateUtf8()`，不得切断多字节字符。
2. 实现 `limitMatches()`，返回原始数量、返回数量和截断状态。
3. 覆盖空值、边界值、中文、emoji 和超限输入。

**验证：** 运行 `npx vitest run tests/unit/tools/limits.test.ts`，期望字节和匹配限制测试全部通过。

## T4：实现严格 UTF-8 文本守卫

**文件：** `src/tools/utf8.ts`、`tests/unit/tools/utf8.test.ts`

**依赖：** T1、T3

**步骤：**

1. 使用严格解码实现 `assertUtf8Text()`，无效序列返回 `invalid_utf8`。
2. 对 NUL 等明确二进制信号返回 `binary_file`。
3. 实现受限读取并报告完整文件字节数与截断信息。
4. 测试中文、代码文本、无效 UTF-8、NUL 数据及大文件。

**验证：** 运行 `npx vitest run tests/unit/tools/utf8.test.ts`，期望全部通过。

## T5：实现临时工作区测试设施与路径守卫

**文件：** `tests/helpers/temporary-workspace.ts`、`src/tools/workspace-paths.ts`、`tests/unit/tools/workspace-paths.test.ts`

**依赖：** T1

**步骤：**

1. 创建可自动清理的临时目录测试助手，支持写文本、写二进制和按能力创建链接/junction。
2. 实现启动根目录 realpath、相对路径验证和 Windows 大小写无关的路径段包含判断。
3. 实现已有文件、新文件父目录和搜索根的解析接口。
4. 拒绝绝对路径、盘符路径、空路径、`..`、外部链接和 junction 逃逸。
5. 对当前系统不允许创建链接的测试明确标记跳过。

**验证：** 运行 `npx vitest run tests/unit/tools/workspace-paths.test.ts`，期望所有可用平台能力场景通过且不访问临时根之外。

## T6：实现读取文件工具

**文件：** `src/tools/implementations/read-file.ts`、`tests/unit/tools/read-file.test.ts`

**依赖：** T3、T4、T5

**步骤：**

1. 使用严格 Zod Schema 定义 `path` 参数并导出对应 JSON Schema。
2. 通过路径和 UTF-8 守卫读取工作区文件。
3. 返回相对路径、受限内容、完整字节数和截断信息。
4. 测试文本、Unicode、超限、不存在、目录、二进制、无效 UTF-8 和越界。

**验证：** 运行 `npx vitest run tests/unit/tools/read-file.test.ts`，期望全部通过。

## T7：实现排他创建文件工具

**文件：** `src/tools/implementations/write-file.ts`、`tests/unit/tools/write-file.test.ts`

**依赖：** T4、T5

**步骤：**

1. 定义严格的 `path/content` 参数 Schema 和 JSON Schema。
2. 验证父目录存在且真实路径位于工作区，不自动创建目录。
3. 使用排他创建完整写入 UTF-8，失败时只清理本次创建的残缺目标。
4. 测试成功、目标已存在、父目录缺失、越界、并发冲突和模拟写入失败。

**验证：** 运行 `npx vitest run tests/unit/tools/write-file.test.ts`，期望原文件不被覆盖且失败不留下残缺文件。

## T8：实现唯一匹配修改文件工具

**文件：** `src/tools/implementations/edit-file.ts`、`tests/unit/tools/edit-file.test.ts`

**依赖：** T4、T5

**步骤：**

1. 定义严格的 `path/oldText/newText` 参数 Schema 和 JSON Schema。
2. 严格读取 UTF-8，按字面值统计 `oldText` 匹配次数。
3. 仅一次匹配时在同目录写临时文件，并按 Windows 安全流程提交替换。
4. 在零匹配、多匹配、取消、权限错误和提交失败时保留原文件并清理临时文件。
5. 测试 Unicode、多行文本和包含正则特殊字符但按字面解释的输入。

**验证：** 运行 `npx vitest run tests/unit/tools/edit-file.test.ts`，期望成功仅替换一处，所有失败场景原文件保持不变。

## T9：实现文件查找工具

**文件：** `src/tools/implementations/find-files.ts`、`tests/unit/tools/find-files.test.ts`

**依赖：** T3、T5

**步骤：**

1. 定义严格的 glob `pattern` 参数 Schema。
2. 使用 Node.js 24 glob 从工作区查找普通文件，输出正斜杠相对路径。
3. 不跟随越界链接；按固定数量限制结果并统计原始匹配数。
4. 测试嵌套目录、Unicode、无匹配、非法模式、截断和链接边界。

**验证：** 运行 `npx vitest run tests/unit/tools/find-files.test.ts`，期望结果只包含工作区普通文件。

## T10：实现文本搜索工具

**文件：** `src/tools/implementations/search-text.ts`、`tests/unit/tools/search-text.test.ts`

**依赖：** T3、T4、T5、T9

**步骤：**

1. 定义 `query` 和可选 `filePattern` 的严格参数 Schema。
2. 对符合 glob 的文件执行普通字符串搜索，返回一基行号、列号和匹配行。
3. 支持同一行多个匹配；跳过二进制、无效 UTF-8 和不可读文件并报告跳过规模。
4. 达到匹配上限后停止收集并标记截断。
5. 测试中文、代码片段、多匹配、过滤模式、跳过文件及截断。

**验证：** 运行 `npx vitest run tests/unit/tools/search-text.test.ts`，期望匹配位置与内容准确且不返回二进制内容。

## T11：实现 PowerShell 命令工具

**文件：** `src/tools/implementations/run-command.ts`、`tests/unit/tools/run-command.test.ts`

**依赖：** T3、T5

**步骤：**

1. 定义非空 `command` 参数 Schema，不接受 cwd、超时或权限参数。
2. 显式启动 PowerShell，以工作区为 cwd，管道捕获 stdout/stderr。
3. 全程消费输出，只保留各自上限内 UTF-8 文本并统计原始字节数。
4. 非零退出返回 `command_failed` 与 partial output。
5. 收到取消时终止 Windows 进程树并等待收尾。
6. 测试 cwd、stdout/stderr、非零退出、Unicode、大输出、取消和子进程终止。

**验证：** 运行 `npx vitest run tests/unit/tools/run-command.test.ts`，期望全部通过且测试结束后没有遗留测试进程。

## T12：实现统一工具执行器

**文件：** `src/tools/executor.ts`、`tests/unit/tools/executor.test.ts`

**依赖：** T2、T3、T6–T11

**步骤：**

1. 按调用名从注册中心取得工具并注入工作区和固定限制。
2. 合并回合取消信号与按 effect 选择的固定超时信号。
3. 将未知工具、超时、取消和未处理异常转换为一个终态结构化结果。
4. 确保模型参数无法覆盖限制。
5. 测试成功、未知工具、抛异常、超时和外部取消。

**验证：** 运行 `npx vitest run tests/unit/tools/executor.test.ts`，期望每次调用恰好收敛为一个终态结果。

## T13：扩展 Provider 统一类型并实现调用组装器

**文件：** `src/providers/types.ts`、`src/tools/call-assembler.ts`、`tests/unit/tools/call-assembler.test.ts`

**依赖：** T1、T2

**步骤：**

1. 将 `ChatRequest` 扩展为协议无关上下文项、工具定义和 `initial/final` 阶段。
2. 为 `StreamEvent` 增加调用开始、参数 delta 和结束事件，为结束原因增加 `tool_calls`。
3. 保留 s01 ProviderState 和普通聊天能力，按规则保留被替换实现。
4. 实现组装器的标识跟踪、片段拼接、完整性检查、JSON 解析、工具查找和参数校验。
5. 测试交错多调用、损坏 JSON、缺片、重复开始、未知标识、未知工具和参数错误。

**验证：** 运行 `npx vitest run tests/unit/tools/call-assembler.test.ts tests/integration/provider-streaming.test.ts`，期望组装测试及原普通流测试通过。

## T14：扩展存储类型并添加数据库迁移

**文件：** `src/storage/types.ts`、`src/storage/migrations/002-tool-calls.ts`、`src/storage/migrations/index.ts`、`tests/unit/storage/migrations.test.ts`

**依赖：** T1

**步骤：**

1. 增加 `ToolCallRecord`、`StoredConversation` 和 plan 中的仓储方法签名。
2. 新建版本 2 迁移，创建 `tool_calls` 表、约束和按会话/助手/顺序查询的索引。
3. 保持版本 1 SQL 不变，并在迁移索引中按版本顺序登记。
4. 测试新库与从版本 1 升级、重复初始化和约束。

**验证：** 运行 `npx vitest run tests/unit/storage/migrations.test.ts`，期望新建与升级场景均到达版本 2 且 s01 数据保留。

## T15：扩展 Storage Worker 协议与仓储入口

**文件：** `src/storage/worker-protocol.ts`、`src/storage/repository.ts`、`src/storage/worker-client.ts`

**依赖：** T14

**步骤：**

1. 为完整会话读取、原子首轮终结/批次保存、审批、运行、结果、continuation 和中断恢复增加 Worker 请求类型。
2. 在 `SessionRepository` 中实现与接口一致的异步代理方法。
3. 更新 Worker client 的判别联合处理，确保响应和错误仍正确关联请求 ID。

**验证：** 运行 `npx eslint src/storage/worker-protocol.ts src/storage/repository.ts src/storage/worker-client.ts`，期望退出码 0；完整 Worker 协议类型闭合在 T16 的存储测试中验证。

## T16：实现工具记录 SQL 与原子事务

**文件：** `src/storage/worker.ts`、`tests/unit/storage/repository.test.ts`、`tests/integration/tool-persistence.test.ts`

**依赖：** T15

**步骤：**

1. 实现数据库行与 `ToolCallRecord` 的 JSON 序列化/反序列化及状态验证。
2. 实现 `getConversation()`。
3. 在一个事务中实现 `finalizeInitialAssistantAndSaveToolBatch()`。
4. 实现审批、running、终态结果和 assistant continuation 更新。
5. 初始化时把 `pending/approved/queued/running` 原子转换为 `interrupted`。
6. 测试成功/失败/拒绝/超时记录、事务回滚、重启恢复及工具与消息关联。

**验证：** 运行 `npx vitest run tests/unit/storage/repository.test.ts tests/integration/tool-persistence.test.ts tests/integration/storage-worker.test.ts`，期望全部通过。

## T17：适配 Anthropic 工具协议

**文件：** `src/providers/anthropic.ts`、`tests/unit/providers/anthropic.test.ts`、`tests/fixtures/streams/anthropic-tools.txt`

**依赖：** T13

**步骤：**

1. 将统一定义转换为 Anthropic tools。
2. 将消息、助手调用和结果转换为 `tool_use/tool_result` 内容块。
3. 把内容块开始、`input_json_delta` 和结束转换为统一调用事件，并支持一批多个调用。
4. 保留 text、thinking、usage、取消和 adaptive/manual 回退。
5. 确认未使用 SDK 自动工具循环。

**验证：** 运行 `npx vitest run tests/unit/providers/anthropic.test.ts`，期望普通流、thinking 回退和多工具分片测试全部通过。

## T18：适配 OpenAI Responses 工具协议

**文件：** `src/providers/openai-responses.ts`、`tests/unit/providers/openai-responses.test.ts`、`tests/fixtures/streams/openai-responses-tools.txt`

**依赖：** T13

**步骤：**

1. 将统一定义转换为 Responses function tools。
2. 将上下文调用与结果转换为 `function_call/function_call_output`。
3. 把 output item 和参数 delta 转换为统一调用事件。
4. 继续设置 `store: false`，保留非工具 replay 状态并过滤统一记录已表达的 function calls。
5. 测试多个交错调用、回灌、最终阶段无工具定义及 replay 去重。

**验证：** 运行 `npx vitest run tests/unit/providers/openai-responses.test.ts`，期望普通文本、replay 和工具流程测试全部通过。

## T19：适配 OpenAI Chat 工具协议

**文件：** `src/providers/openai-chat.ts`、`tests/unit/providers/openai-chat.test.ts`、`tests/fixtures/streams/openai-chat-tools.txt`

**依赖：** T13

**步骤：**

1. 将统一定义转换为 Chat Completions function tools。
2. 将上下文转换为 `assistant.tool_calls` 和 `tool` 消息。
3. 按流式 `index` 关联调用 ID、名称和参数片段，支持交错调用。
4. 保留文本、用量、取消与错误映射。
5. 测试一批多调用、结果回灌和 final 阶段无定义。

**验证：** 运行 `npx vitest run tests/unit/providers/openai-chat.test.ts`，期望普通与工具流测试全部通过。

## T20：验证三协议统一工具流

**文件：** `tests/integration/provider-tool-streaming.test.ts`、`tests/integration/provider-streaming.test.ts`

**依赖：** T17、T18、T19

**步骤：**

1. 用三种本地模拟流表达同一批工具调用和参数分片。
2. 断言统一事件的名称、供应商 ID、位置、参数文本和结束原因一致。
3. 验证三者获得同一注册中心的六个定义。
4. 保留无工具普通流的既有集成覆盖。

**验证：** 运行 `npx vitest run tests/integration/provider-tool-streaming.test.ts tests/integration/provider-streaming.test.ts`，期望全部通过。

## T21：实现审批协调器

**文件：** `src/tools/approval-coordinator.ts`、`tests/unit/tools/approval-coordinator.test.ts`

**依赖：** T1

**步骤：**

1. 只为 `write/command` 创建审批 Promise，生成受限参数摘要。
2. 命令提示固定包含网络、子进程和工作区外风险。
3. 一次只暴露一个 pending prompt，严格按 call ID 解析决定。
4. `interruptAll()` 将所有等待者收敛为中断，不留下 Promise。
5. 测试批准、拒绝、错误 ID、重复决定和取消。

**验证：** 运行 `npx vitest run tests/unit/tools/approval-coordinator.test.ts`，期望全部通过。

## T22：实现工具批次协调器

**文件：** `src/tools/batch-coordinator.ts`、`tests/unit/tools/batch-coordinator.test.ts`

**依赖：** T12、T16、T21

**步骤：**

1. 将无效调用直接保存为 failed 结果。
2. 使用 `Promise.allSettled` 并行执行所有 read 调用。
3. 把 write/command 合并后按 position 逐项审批和串行执行。
4. 审批决定先持久化，再启动副作用；每项 running 和终态均持久化。
5. 两分支同时推进，单项失败隔离，最终按 position 汇总。
6. 取消时保留已完成结果并中断未启动/活跃调用。

**验证：** 运行 `npx vitest run tests/unit/tools/batch-coordinator.test.ts`，期望并行重叠、串行顺序、部分拒绝、错误隔离和取消测试全部通过。

## T23：扩展对话上下文构造

**文件：** `src/chat/context.ts`、`tests/unit/chat/context.test.ts`

**依赖：** T13、T16

**步骤：**

1. 将输入改为 `StoredConversation`，构造 `MessageContextItem`、`ToolCallContextItem` 和 `ToolResultContextItem`。
2. 按首个助手消息关联调用和结果，并保持原始顺序。
3. 保留 s01 对 completed/cancelled/failed 普通消息的过滤语义。
4. 将成功、失败、拒绝、超时和中断工具结果纳入历史。
5. 测试空正文工具助手、重复同名调用、孤立记录和 Responses state。

**验证：** 运行 `npx vitest run tests/unit/chat/context.test.ts`，期望普通历史和工具历史测试全部通过。

## T24：实现单回合编排器

**文件：** `src/chat/turn-orchestrator.ts`、`tests/unit/chat/turn-orchestrator.test.ts`、`tests/helpers/mock-llm-client.ts`

**依赖：** T20、T22、T23

**步骤：**

1. 扩展 MockLLMClient 记录 phase、items 和 tools，并支持按请求序号返回不同流。
2. 实现 initial 流文本/thinking/usage 更新及工具事件组装。
3. 无工具时直接终结，不创建工具记录或第二请求。
4. 有工具时原子终结首个助手/保存批次，执行协调器，创建 continuation 并发起 final 请求。
5. final 不提供工具定义；新调用保存为 `skipped/agent_loop_limit`，不审批、不执行、不发第三请求。
6. 实现首轮/最终 Provider 错误、意外结束和取消收尾。

**验证：** 运行 `npx vitest run tests/unit/chat/turn-orchestrator.test.ts`，期望普通单请求、工具双请求、限制第二批、错误和取消测试全部通过。

## T25：扩展应用状态和控制器

**文件：** `src/chat/state.ts`、`src/chat/controller.ts`、`tests/unit/chat/state.test.ts`、`tests/integration/chat-controller.test.ts`

**依赖：** T16、T21、T24

**步骤：**

1. 在 `AppState` 增加工具记录、待审批提示及审批/执行请求状态。
2. 初始化和切换会话时使用 `getConversation()` 发布消息与工具记录。
3. `sendMessage()` 委托 TurnOrchestrator，保持已有 checkpoint 与取消语义等价。
4. 实现 `resolveToolApproval()`，生成/审批/执行时阻止新建或切换会话。
5. shutdown 先取消整个活动回合并等待工具和存储收尾。
6. 测试普通流回归、审批、部分拒绝、取消和恢复。

**验证：** 运行 `npx vitest run tests/unit/chat/state.test.ts tests/integration/chat-controller.test.ts`，期望全部通过。

## T26：实现工具记录 TUI 组件

**文件：** `src/tui/components/tool-call-card.tsx`、`src/tui/components/tool-call-list.tsx`、`tests/tui/tool-components.test.tsx`

**依赖：** T1

**步骤：**

1. 显示名称、受限参数摘要、审批状态、执行状态和结果摘要。
2. 对等待、批准、拒绝、运行、成功、失败、超时、中断和跳过使用清晰中文标签。
3. 按 position 稳定排序，并避免完整大输出占满消息区。
4. 测试各状态、Unicode 和截断摘要。

**验证：** 运行 `npx vitest run tests/tui/tool-components.test.tsx`，期望全部通过。

## T27：实现审批面板与键盘优先级

**文件：** `src/tui/components/tool-approval-panel.tsx`、`src/tui/screens/chat-screen.tsx`、`src/tui/components/prompt-input.tsx`、`tests/tui/chat-screen.test.tsx`

**依赖：** T21、T25

**步骤：**

1. 审批面板显示工具、关键参数、`Y/N` 提示及命令风险。
2. pending 时优先拦截 `Y`、`N` 和 `Ctrl+C`，不得同时触发聊天快捷键。
3. 审批和执行阶段禁用普通输入，新建/历史切换不可用。
4. 保持取消、布局缩放和会话列表既有行为。
5. 测试批准、拒绝、命令提示、错误按键、取消及输入禁用。

**验证：** 运行 `npx vitest run tests/tui/chat-screen.test.tsx tests/tui/keyboard.test.tsx`，期望全部通过。

## T28：把工具记录集成进聊天展示

**文件：** `src/tui/components/message.tsx`、`src/tui/components/message-list.tsx`、`src/tui/components/status-bar.tsx`、`tests/tui/app.test.tsx`

**依赖：** T25、T26、T27

**步骤：**

1. 按 `assistantMessageId` 把工具列表挂在对应助手消息下。
2. 让消息列表接收工具记录并保持滚动、选择和 thinking 展示。
3. 状态栏显示等待审批、执行工具和取消状态。
4. 测试历史工具记录、空正文工具助手及普通消息回归。

**验证：** 运行 `npx vitest run tests/tui/app.test.tsx tests/tui/tool-components.test.tsx tests/tui/chat-screen.test.tsx`，期望全部通过。

## T29：组装六个工具并捕获工作区

**文件：** `src/cli/bootstrap.ts`、`tests/unit/providers/factory.test.ts`

**依赖：** T12、T17–T19、T24、T25

**步骤：**

1. 启动时捕获并 realpath 当前工作区，失败时产生明确启动错误。
2. 定义 plan 中固定超时和结果上限常量。
3. 创建路径/文本设施、六工具、注册中心、执行器、审批器、批次协调器和回合编排器。
4. 将其连接到选定 Provider、Repository 和 ChatController。
5. 不从配置或模型参数读取工作区、超时和上限。

**验证：** 运行 `npx vitest run tests/unit/providers/factory.test.ts tests/tui/app.test.tsx`，期望应用组装与既有 profile 流程通过。

## T30：覆盖完整工具回合集成场景

**文件：** `tests/integration/tool-turn.test.ts`

**依赖：** T22–T29

**步骤：**

1. 在临时工作区模拟一批读取、创建、修改、命令、查找和搜索调用。
2. 驱动逐项审批，包含批准、拒绝、失败和超时结果。
3. 断言只读调用重叠、副作用顺序串行、整批按 position 回灌。
4. 断言 final 生成总结，第二批调用被跳过，模型请求总数不超过两次。
5. 覆盖取消审批和取消活跃命令后不回灌。

**验证：** 运行 `npx vitest run tests/integration/tool-turn.test.ts`，期望全部端到端模拟场景通过。

## T31：执行安全、资源与回归专项测试

**文件：** `tests/integration/provider-tool-streaming.test.ts`、`tests/integration/tool-persistence.test.ts`、`tests/integration/chat-controller.test.ts`、相关 `tests/unit/tools/*.test.ts`

**依赖：** T30

**步骤：**

1. 运行路径穿越、链接逃逸、二进制、无效 UTF-8、覆盖冲突和非唯一替换测试。
2. 运行大文件、大量匹配、大 stdout/stderr 和超时/取消测试。
3. 运行持久化中断恢复、密钥不泄漏和单项失败隔离测试。
4. 运行三协议普通文本、thinking、取消和历史恢复回归。

**验证：** 运行 `npx vitest run tests/unit/tools tests/unit/providers tests/unit/chat tests/unit/storage tests/integration tests/tui`，期望全部测试通过且无外网或真实 API Key 需求。

## T32：更新项目阶段约束和用户文档

**文件：** `AGENT.md`、`README.md`

**依赖：** T30

**步骤：**

1. 将当前状态更新为 s02，并把 s01 的“禁止工具”约束替换为本阶段六工具和一次回灌边界；按留痕规则保留旧约束来源。
2. 在 README 说明六个工具、工作区范围、逐项审批、`Y/N` 操作、命令外部风险、文本限制、超时/截断和无 Agent Loop。
3. 保持配置、快捷键和既有聊天说明准确。

**验证：** 运行 `rg -n "s02|read_file|write_file|edit_file|run_command|find_files|search_text|Agent Loop|工作区|批准|拒绝" AGENT.md README.md`，期望所有新能力和限制均有明确说明且不再声称完全不支持工具。

## T33：编写 s02 项目导读

**文件：** `Project_Guide/s02.md`

**依赖：** T31、T32

**步骤：**

1. 说明从 s01 纯聊天到 s02 有限工具 Agent 的变化。
2. 记录统一类型、六工具、路径安全、审批、批次调度、三协议、SQLite 和 TUI 数据流。
3. 说明固定限制、命令非沙箱风险、不支持项目及如何运行自动/人工验收。
4. 在最终验收后回填真实命令和结果，不写推测性结论。

**验证：** 运行 `rg -n "架构|工具|审批|Anthropic|Responses|Chat|SQLite|安全|验收" Project_Guide/s02.md`，期望导读覆盖全部主要模块和验证入口。

## T34：执行完整质量检查并修复回归

**文件：** 本任务涉及的全部源码与测试；只修改实际失败所对应的文件

**依赖：** T31、T33

**步骤：**

1. 运行类型检查，修复所有类型错误。
2. 运行 ESLint，修复所有 lint 错误且不禁用必要规则。
3. 运行全量测试，修复失败并重跑关联测试。
4. 运行构建并检查 CLI help 可启动。
5. 检查源码注释状态标签和敏感信息扫描。

**验证：** 运行 `npm run check`，随后运行 `node dist/bin/mycode.js --help`；期望两者退出码均为 0。

## T35：按 checklist 回填自动验收证据

**文件：** `spec_docs/s02/checklist.md`、`Project_Guide/s02.md`

**依赖：** T34；并要求 `checklist.md` 已在开发前获批

**步骤：**

1. 逐项运行 checklist 中的自动验证命令并记录真实输出。
2. 只把有证据的条目标记为通过；人工 Windows Terminal/真实 Provider 项保持待验收，除非已实际执行。
3. 对失败项修复、重跑并保留最终证据。
4. 将最终自动验收摘要同步到 s02 导读。

**验证：** 运行 `rg -n "\[x\]|\[ \]|证据|实际" spec_docs/s02/checklist.md Project_Guide/s02.md`，期望所有勾选项都有实际证据，未执行项保持未勾选。

## 执行顺序

```text
T1
├─→ T2
├─→ T3 → T4
├─→ T5
└─→ T14 → T15 → T16

T3 + T4 + T5
├─→ T6
├─→ T7
├─→ T8
├─→ T9 → T10
└─→ T11

T2 + T6…T11 → T12
T1 + T2       → T13

T13
├─→ T17 ─┐
├─→ T18 ─┼→ T20
└─→ T19 ─┘

T1  → T21
T12 + T16 + T21 → T22
T13 + T16       → T23
T20 + T22 + T23 → T24
T16 + T21 + T24 → T25

T1             → T26
T21 + T25      → T27
T25 + T26 + T27 → T28
T12 + T17…T19 + T24 + T25 → T29

T22…T29 → T30 → T31
T30 → T32
T31 + T32 → T33
T31 + T33 → T34 → T35
```

合法并行组：

- T3、T5、T14 可在 T1 后并行。
- T6、T7、T8、T9、T11 可在各自基础设施完成后并行。
- T17、T18、T19 可在 T13 后并行。
- T21、T26 可与 Provider 和存储实现并行。
- T32 可在 T30 后与 T31 的专项验证并行。

实现期间只有上述明确列出的组允许并行；共享文件冲突时改为串行，不得同时编辑同一文件。
