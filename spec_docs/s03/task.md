# MyCode Agent Loop Tasks

## 实施进度（2026-08-23）

- [x] T1–T30：基础契约、存储 v3、有序上下文、工具策略、流收集、安全调度、AgentRunner、三协议有序请求、事件投影、控制器、TUI、Agent Loop 与 Plan Mode 集成完成。
- [x] T31–T32：模型流/审批取消与进程中断恢复专项测试完成。
- [x] T35–T36：用户文档、s03 导读、完整质量入口、覆盖率、CLI 冒烟和真实终端验收完成。
- [x] T33–T34 按项目状态留痕要求关闭：不删除 s01/s02 兼容字段与 `LegacyChatController`。当前组合根和主流程只实例化 `AgentRunner`；旧入口继续作为可编译、可回归的阶段代码保留，不属于待清理项。若未来另行决定删除，必须先变更 `AGENT.md` 的阶段保留规则并迁移旧协议测试。

验证实绩：`npm run check` 通过（45 个测试文件、137 个测试项）；`npm run test:coverage` 通过（整体语句 62.14%，Agent 目录语句 91.4%）；CLI `--help` 冒烟通过。已用真实 DeepSeek Anthropic 兼容 profile 在 Windows PTY 完成 Plan/Do、逐项审批、拒绝、失败后调整、三种取消、取消后继续、会话模式与 Token 恢复验收。官方 Anthropic、OpenAI Responses、OpenAI Chat 三个原生端点未分别实测，因此本阶段结论为“s03 基本完成”，而不是“所有供应商真实端到端均完成”。

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/agent/types.ts` | Agent 运行、事件、停止和工具准备类型 |
| 新建 | `src/agent/tool-policy.ts` | Plan/Execute 工具策略和调用分类 |
| 新建 | `src/agent/stream-collector.ts` | 模型流实时事件与完整响应双路收集 |
| 新建 | `src/agent/context.ts` | 有序多轮模型上下文 |
| 新建 | `src/agent/safety-batch-scheduler.ts` | 连续只读并发与副作用安全屏障 |
| 新建 | `src/agent/runner.ts` | ReAct Agent Loop 和停止条件 |
| 新建 | `src/chat/agent-event-projector.ts` | Agent 事件到存储和 AppState 的投影 |
| 新建 | `src/chat/commands.ts` | `/plan`、`/do` 精确解析 |
| 修改 | `src/chat/controller.ts` | 委托 AgentRunner、命令、取消和会话恢复 |
| 修改 | `src/chat/context.ts` | 旧消息兼容和有序上下文入口 |
| 修改 | `src/chat/state.ts` | 模式、迭代进度、累计用量和停止状态 |
| 修改 | `src/providers/types.ts` | 有序模型上下文和统一请求契约 |
| 修改 | `src/providers/anthropic.ts` | Anthropic 多轮工具上下文转换 |
| 修改 | `src/providers/openai-responses.ts` | Responses 多轮上下文和重放去重 |
| 修改 | `src/providers/openai-chat.ts` | Chat Completions 多轮工具消息转换 |
| 新建 | `src/storage/migrations/003-agent-loop.ts` | 数据库版本 3 |
| 修改 | `src/storage/migrations/index.ts` | 登记版本 3 |
| 修改 | `src/storage/types.ts` | Agent 回合、会话模式和关联字段 |
| 修改 | `src/storage/worker-protocol.ts` | Agent 存储操作协议 |
| 修改 | `src/storage/worker.ts` | 行映射、事务、新操作和中断恢复 |
| 修改 | `src/storage/repository.ts` | 新仓储操作门面 |
| 修改 | `src/tools/types.ts` | 模式不可用错误和原始参数契约 |
| 修改 | `src/tools/approval-coordinator.ts` | 取消状态与新调度器协作 |
| 修改 | `src/cli/bootstrap.ts` | 组装 Runner、Collector、Scheduler 和 Projector 依赖 |
| 修改 | `src/tui/screens/chat-screen.tsx` | Agent 状态下输入、取消和审批路由 |
| 修改 | `src/tui/components/status-bar.tsx` | PLAN/DO、N/20 和累计 Token |
| 修改 | `src/tui/components/message-list.tsx` | 独立迭代与工具记录关联展示 |
| 修改 | `src/tui/components/tool-call-card.tsx` | 模式不可用、上限和中断摘要 |
| 修改 | `tests/helpers/mock-llm-client.ts` | 按请求序号提供模型流 |
| 新建 | `tests/helpers/controlled-stream.ts` | 可暂停、释放、报错和取消的异步流 |
| 新建 | `tests/unit/agent/runner.test.ts` | 循环、停止、取消和用量测试 |
| 新建 | `tests/unit/chat/commands.test.ts` | 控制命令测试 |
| 修改 | `tests/unit/chat/state.test.ts` | 新 AppState 回归 |
| 修改 | `tests/unit/chat/context.test.ts` | 旧消息和工具历史兼容 |
| 修改 | `tests/unit/providers/anthropic.test.ts` | Anthropic 有序上下文测试 |
| 修改 | `tests/unit/providers/openai-responses.test.ts` | Responses 多轮重放测试 |
| 修改 | `tests/unit/providers/openai-chat.test.ts` | Chat 多轮工具消息测试 |
| 修改 | `tests/unit/storage/migrations.test.ts` | 版本 3 和旧库升级测试 |
| 修改 | `tests/unit/storage/repository.test.ts` | Agent 仓储事务测试 |
| 新建 | `tests/integration/plan-mode.test.ts` | `/plan`、`/do` 和会话隔离集成 |
| 新建 | `tests/integration/agent-cancellation.test.ts` | 流、审批和工具取消集成 |
| 新建 | `tests/integration/agent-recovery.test.ts` | 非终态启动恢复集成 |
| 修改 | `tests/integration/tool-turn.test.ts` | s02 有限回合升级为循环回归 |
| 修改 | `tests/integration/chat-controller.test.ts` | 控制器事件消费和多迭代消息 |
| 修改 | `tests/integration/provider-streaming.test.ts` | 三协议 Agent 行为一致性 |
| 修改 | `tests/integration/storage-worker.test.ts` | 版本 3 存储往返 |
| 修改 | `tests/tui/chat-screen.test.tsx` | 命令、进度、取消和审批键位 |
| 修改 | `tests/tui/app.test.tsx` | 模式和进度展示回归 |
| 修改 | `AGENT.md` | 当前阶段更新为 s03 |
| 修改 | `README.md` | Agent Loop、Plan Mode 和停止行为 |
| 新建 | `Project_Guide/s03.md` | s03 中文导读和真实验证记录 |

> 上表按仓库当前真实文件修正。原计划中的 Collector、Scheduler、Projector 与完整 Agent Loop 独立测试文件没有单独落盘；相关行为由 `runner.test.ts`、`tool-turn.test.ts`、`plan-mode.test.ts`、`agent-cancellation.test.ts`、`chat-controller.test.ts` 及真实 DeepSeek 验收共同覆盖。此合并不影响质量入口，但若要求逐条机械执行原 AC 命令，仍需补建同名专项测试文件。

## T1：建立 Agent 与有序 Provider 契约

**文件：** `src/agent/types.ts`、`src/providers/types.ts`、`src/tools/types.ts`

**依赖：** 无

**步骤：**
1. 新增 Agent 模式、阶段、运行状态、停止原因、事件、运行输入和结果类型。
2. 在 Provider 类型中加入 `ModelContextItem`、原始工具参数和有序 `ChatRequest.items`。
3. 为工具错误增加 `tool_unavailable_in_mode`，并补足准备调用所需字段。
4. 保留 s02 请求字段作为阶段兼容入口，使旧状态代码和回归测试继续可编译；s03 主流程只使用有序请求。
5. 所有新解释性注释使用 `[s03]`，被替换定义按状态留痕规则保留。

**验证：** 运行 `npm run typecheck`，期望退出码 0，且新增类型不要求 Agent 层依赖存储或 TUI。

## T2：扩展多请求测试客户端与受控流

**文件：** `tests/helpers/mock-llm-client.ts`、`tests/helpers/controlled-stream.ts`、`tests/helpers/controlled-stream.test.ts`

**依赖：** T1

**步骤：**
1. 让 `MockLLMClient` 支持按模型请求序号返回不同事件序列，同时兼容单序列旧测试。
2. 记录每次完整 `ChatRequest`，并在请求超出脚本时抛出清晰测试错误。
3. 实现可逐步释放事件、正常结束、意外结束和主动抛错的受控异步流。
4. 验证取消信号后不再释放后续事件。

**验证：** 运行 `npx --no-install vitest run tests/helpers/controlled-stream.test.ts tests/integration/chat-controller.test.ts`，期望所选测试全部通过。

## T3：实现 `/plan` 与 `/do` 命令解析

**文件：** `src/chat/commands.ts`、`tests/unit/chat/commands.test.ts`

**依赖：** 无

**步骤：**
1. 实现去除首尾空白后的精确小写命令识别。
2. 确认 `/plan x`、`/do x`、大小写变体和普通斜杠文本均作为普通消息。
3. 为纯空白输入保持现有“不发送”语义，不把它识别为命令。

**验证：** 运行 `npx --no-install vitest run tests/unit/chat/commands.test.ts`，期望全部命令边界用例通过。

## T4：新增数据库版本 3

**文件：** `src/storage/migrations/003-agent-loop.ts`、`src/storage/migrations/index.ts`、`tests/unit/storage/migrations.test.ts`

**依赖：** T1

**步骤：**
1. 新增 `agent_runs` 表及会话、消息、工具调用所需列和索引。
2. 旧会话的 `agent_mode` 默认设为 `execute`。
3. 旧工具记录的 `arguments_text` 从 `arguments_json` 回填。
4. 旧消息和工具记录的 Agent 关联保持 `NULL`，不伪造历史回合。
5. 增加从版本 2 升级和重复执行迁移的测试。

**验证：** 运行 `npx --no-install vitest run tests/unit/storage/migrations.test.ts`，期望数据库版本为 3，旧数据内容保持且新列可读写。

## T5：扩展存储类型、行映射和恢复语义

**文件：** `src/storage/types.ts`、`src/storage/worker.ts`、`tests/unit/storage/repository.test.ts`

**依赖：** T4

**步骤：**
1. 增加 `AgentRunRecord`，扩展 `Session`、`StoredMessage`、`ToolCallRecord` 和 `StoredConversation`。
2. 更新 Worker 行类型与映射函数，严格验证 JSON、枚举和可空旧数据。
3. 初始化时将遗留 `running` 回合标为 `interrupted/process_interrupted`。
4. 将遗留 `streaming` 消息和非终态工具调用转换为准确中断状态。
5. 增加恢复映射测试，确认已完成记录不被改写。

**验证：** 运行 `npx --no-install vitest run tests/unit/storage/repository.test.ts tests/unit/storage/migrations.test.ts`，期望映射和恢复测试通过。

## T6：实现会话模式与 Agent 回合事务

**文件：** `src/storage/worker-protocol.ts`、`src/storage/worker.ts`、`src/storage/repository.ts`、`src/storage/types.ts`、`tests/unit/storage/repository.test.ts`

**依赖：** T5

**步骤：**
1. 增加 `set_session_mode` 操作并返回更新后的 `Session`。
2. 增加 `begin_agent_run`，在单一事务中创建 user 消息和 `agent_runs` 行。
3. 保留首次用户消息生成会话标题的既有规则。
4. 拒绝不存在的会话和不合法模式，不留下半条记录。

**验证：** 运行 `npx --no-install vitest run tests/unit/storage/repository.test.ts`，期望模式隔离、原子开始回合和失败回滚用例通过。

## T7：实现迭代、工具批次和回合完成事务

**文件：** `src/storage/worker-protocol.ts`、`src/storage/worker.ts`、`src/storage/repository.ts`、`src/storage/types.ts`、`tests/unit/storage/repository.test.ts`

**依赖：** T6

**步骤：**
1. 增加以外部 UUID 创建 assistant 迭代消息的操作，并保存回合 ID 和一基迭代序号。
2. 增加原子终结迭代并保存完整工具批次的操作。
3. 保留逐项更新审批、执行和结果的能力，并验证只更新目标记录。
4. 增加完成 Agent 回合的操作；Plan Mode 自然完成时同事务更新最新计划引用。
5. 确保取消、失败、受限运行不会覆盖已有最新计划。

**验证：** 运行 `npx --no-install vitest run tests/unit/storage/repository.test.ts`，期望迭代、批次、回合和计划事务用例全部通过。

## T8：验证版本 3 Storage Worker 往返

**文件：** `tests/integration/storage-worker.test.ts`

**依赖：** T7

**步骤：**
1. 通过真实 Worker 创建模式、Agent 回合、多个迭代和工具记录。
2. 保存逐迭代用量、回合累计用量和停止原因。
3. 关闭并重新打开数据库，验证完整 Conversation 恢复一致。
4. 验证两个会话的模式和计划互不影响。

**验证：** 运行 `npx --no-install vitest run tests/integration/storage-worker.test.ts`，期望真实 Worker 往返测试全部通过。

## T9：实现有序 AgentContext

**文件：** `src/agent/context.ts`、`src/chat/context.ts`、`tests/unit/agent/context.test.ts`、`tests/unit/chat/context.test.ts`

**依赖：** T1、T5

**步骤：**
1. 从已排序消息和按助手消息关联的工具记录构造有序上下文。
2. 让同一次助手迭代的正文、工具调用和结果保持相邻。
3. 支持在内存追加 user、assistant iteration 和 tool results。
4. 保留已完成及有正文的取消消息，排除失败和不可重放残缺消息。
5. 兼容 s01/s02 没有 Agent 回合关联的历史记录。

**验证：** 运行 `npx --no-install vitest run tests/unit/agent/context.test.ts tests/unit/chat/context.test.ts`，期望多轮顺序和旧历史兼容用例通过。

## T10：实现 Plan/Execute ToolPolicy

**文件：** `src/agent/tool-policy.ts`、`tests/unit/agent/tool-policy.test.ts`

**依赖：** T1

**步骤：**
1. Execute 模式输出全部注册工具，Plan 模式只输出 `effect=read` 工具。
2. 使用完整注册中心把调用分类为 available、unknown、invalid 或 unavailable_in_mode。
3. 保留调用位置、供应商 ID、原始参数和稳定应用 ID。
4. 对模式不可用调用产生独立结构化错误且不进入审批。
5. 验证已注册但参数错误的工具不是 unknown。

**验证：** 运行 `npx --no-install vitest run tests/unit/agent/tool-policy.test.ts`，期望定义过滤和四类调用测试全部通过。

## T11：实现流式文本、思考和用量双路收集

**文件：** `src/agent/stream-collector.ts`、`tests/unit/agent/stream-collector.test.ts`

**依赖：** T2、T10

**步骤：**
1. 手动消费 Provider 异步迭代器并实时产生文本、思考和用量事件。
2. 同时累积完整正文、思考和方向用量；同方向后续用量覆盖本方向旧快照。
3. 正常 `completed` 后返回 `CollectedIteration`。
4. 使用受控流证明首个实时事件在完整流结束前可见。

**验证：** 运行 `npx --no-install vitest run tests/unit/agent/stream-collector.test.ts`，期望实时性、完整内容和用量测试通过。

## T12：完成工具分片、错误与取消收集

**文件：** `src/agent/stream-collector.ts`、`tests/unit/agent/stream-collector.test.ts`

**依赖：** T11

**步骤：**
1. 为每个 Provider internal ID 建立独立草稿并生成稳定应用调用 ID。
2. 实时输出调用开始和参数 delta，结束后交由 ToolPolicy 分类。
3. 保留无效 JSON、不完整调用、未知名称和 Provider 调用 ID 缺失的现场。
4. 显式 error 或无终止事件时返回部分响应和错误。
5. `AbortSignal` 已取消时返回取消语义，不误标为 stream error。

**验证：** 运行 `npx --no-install vitest run tests/unit/agent/stream-collector.test.ts`，期望工具分片、异常结束、显式错误和取消用例通过。

## T13：实现安全段规划

**文件：** `src/agent/safety-batch-scheduler.ts`、`tests/unit/agent/safety-batch-scheduler.test.ts`

**依赖：** T10

**步骤：**
1. 按原始位置排序准备调用。
2. 把相邻 available/read 调用合并为并发段。
3. 把每个 available/write 或 command 调用变成单项副作用段。
4. 保持 unavailable、invalid 和 unknown 的原始位置，用于直接结果。
5. 测试“读、读、写、读、命令”得到四个预期安全段。

**验证：** 运行 `npx --no-install vitest run tests/unit/agent/safety-batch-scheduler.test.ts -t "安全段"`，期望段划分和顺序测试通过。

## T14：执行并发读取和串行副作用

**文件：** `src/agent/safety-batch-scheduler.ts`、`tests/unit/agent/safety-batch-scheduler.test.ts`

**依赖：** T13

**步骤：**
1. 并发启动同一读取段内的所有调用并等待全部 settle。
2. 确认下一段只在前段完全结束后开始。
3. 副作用调用先产生审批事件，决定持久化屏障后再执行。
4. 逐项产生 queued、running、result 和终态事件。
5. 最终按原始 position 返回完整结果。

**验证：** 运行 `npx --no-install vitest run tests/unit/agent/safety-batch-scheduler.test.ts -t "并发|屏障|审批"`，期望并发重叠、屏障顺序和审批前无副作用均有证据通过。

## T15：完成调度失败隔离与取消

**文件：** `src/agent/safety-batch-scheduler.ts`、`src/tools/approval-coordinator.ts`、`tests/unit/agent/safety-batch-scheduler.test.ts`

**依赖：** T14

**步骤：**
1. 无效、未知和模式不可用调用直接产生各自结果。
2. 单项拒绝、失败或超时不阻断后续合法段。
3. 取消时保留已完成调用，将运行中、待审批和未开始调用标为 interrupted。
4. 审批 Promise 因取消解除时优先检查取消信号，不写成 denied。
5. 保证调度器异常不会漏掉可确定终态的调用。

**验证：** 运行 `npx --no-install vitest run tests/unit/agent/safety-batch-scheduler.test.ts`，期望隔离、排序、拒绝、超时和取消测试全部通过。

## T16：实现自然完成与多轮 AgentRunner

**文件：** `src/agent/runner.ts`、`tests/unit/agent/runner.test.ts`

**依赖：** T9、T12、T15

**步骤：**
1. 实现 `run()` 异步生成器和 run/iteration/progress 事件骨架。
2. 每次迭代调用同一 LLMClient，使用当前 ToolPolicy 定义和内存上下文。
3. 手动驱动 Collector 和 Scheduler，转发事件并获取结束值。
4. 将助手调用和工具结果追加到 AgentContext 后自动进入下一轮。
5. 无工具响应以 natural completion 结束。

**验证：** 运行 `npx --no-install vitest run tests/unit/agent/runner.test.ts -t "自然完成|多轮"`，期望一次用户任务自动完成多轮且请求上下文顺序正确。

## T17：实现迭代、未知工具和流错误停止条件

**文件：** `src/agent/runner.ts`、`tests/unit/agent/runner.test.ts`

**依赖：** T16

**步骤：**
1. 固定最多 20 次模型迭代，并阻止第 20 次的新工具调用进入 Scheduler。
2. 为上限调用生成 `agent_loop_limit` 结果和 iteration_limit 终态。
3. 实现全未知迭代计数、已注册调用清零和第三次停止。
4. 显式或意外流错误停止，不执行该次工具且不重试。
5. 确认工具普通失败只回写，不结束 Agent。

**验证：** 运行 `npx --no-install vitest run tests/unit/agent/runner.test.ts -t "上限|未知|流错误"`，期望 20、3 和零重试边界全部通过。

## T18：完成取消、累计 Token 和进度事件

**文件：** `src/agent/runner.ts`、`tests/unit/agent/runner.test.ts`

**依赖：** T17

**步骤：**
1. 在模型流、工具调度和迭代边界检查取消信号。
2. 取消后不创建下一迭代，并产生 user_cancelled 终态。
3. 累加每次迭代最终输入、输出 Token，不对缺失用量做估算。
4. 为 preparing、streaming、scheduling、approval、execution 和 finishing 产生进度事件。
5. 验证事件的 run、iteration 和 call ID 关联稳定且不重复。
6. 使用包含测试 API Key 的 Provider 配置运行模拟场景，序列化全部 AgentEvent，确认事件中不含配置密钥。

**验证：** 运行 `npx --no-install vitest run tests/unit/agent/runner.test.ts`，期望 Runner 全部测试通过。

## T19：转换 Anthropic 有序上下文

**文件：** `src/providers/anthropic.ts`、`tests/unit/providers/anthropic.test.ts`

**依赖：** T1、T9

**步骤：**
1. 按 items 顺序生成 user、assistant content blocks 和 tool_result blocks。
2. 同一助手迭代同时容纳正文与 tool_use。
3. 对无法解析的原始参数使用安全空对象重建调用，错误保留在 tool_result。
4. 保持 extended thinking、adaptive 回退、用量和取消行为。
5. 不调用 SDK 自动工具循环。

**验证：** 运行 `npx --no-install vitest run tests/unit/providers/anthropic.test.ts`，期望多轮顺序、thinking 和错误归一化测试通过。

## T20：转换 OpenAI Chat 有序上下文

**文件：** `src/providers/openai-chat.ts`、`tests/unit/providers/openai-chat.test.ts`

**依赖：** T1、T9

**步骤：**
1. 按 items 顺序生成 user、assistant 和 tool 消息。
2. 同一 assistant 同时保存 content、多个 tool_calls 和原始 arguments 字符串。
3. 保证每个 tool result 紧跟对应调用并使用 provider call ID。
4. 保持 usage、finish reason、错误和取消行为。

**验证：** 运行 `npx --no-install vitest run tests/unit/providers/openai-chat.test.ts`，期望多轮消息顺序和流事件测试通过。

## T21：转换 OpenAI Responses 有序上下文

**文件：** `src/providers/openai-responses.ts`、`tests/unit/providers/openai-responses.test.ts`

**依赖：** T1、T9

**步骤：**
1. 按 items 顺序生成普通消息、function call 和 function_call_output。
2. assistant iteration 有有效 providerState 时原样重放 output items。
3. providerState 已包含调用时不重复插入统一 tool call。
4. 没有 providerState 时根据正文和工具调用安全重建。
5. 保持 `store:false`、usage、错误和取消行为。

**验证：** 运行 `npx --no-install vitest run tests/unit/providers/openai-responses.test.ts`，期望多轮重放、去重和流事件测试通过。

## T22：扩展 AppState 并投影运行与流事件

**文件：** `src/chat/state.ts`、`src/chat/agent-event-projector.ts`、`tests/unit/chat/state.test.ts`、`tests/unit/chat/agent-event-projector.test.ts`

**依赖：** T7、T18

**步骤：**
1. 为 AppState 增加模式、活跃回合、迭代、阶段、累计用量和停止原因。
2. iteration_started 时用 iterationId 创建并发布 streaming assistant 消息。
3. 文本和思考 delta 立即更新不可变状态。
4. usage 和 progress 事件更新状态栏数据。
5. 保留约 200ms checkpoint 节流和终态 flush 语义。

**验证：** 运行 `npx --no-install vitest run tests/unit/chat/state.test.ts tests/unit/chat/agent-event-projector.test.ts -t "运行|流式|用量|进度"`，期望状态和 checkpoint 测试通过。

## T23：投影工具、迭代终态和回合终态

**文件：** `src/chat/agent-event-projector.ts`、`tests/unit/chat/agent-event-projector.test.ts`

**依赖：** T22

**步骤：**
1. 在 iteration_finished 时冲刷 checkpoint 并原子保存消息和工具批次。
2. 将 approval、tool status 和 tool result 事件更新到对应工具记录。
3. run_finished 时保存回合状态、停止原因、用量和可选最新计划。
4. 取消和失败时保留部分消息，不把非终态误标成功。
5. 模拟存储失败，确认 Projector 抛出真实错误且不发布虚假成功。

**验证：** 运行 `npx --no-install vitest run tests/unit/chat/agent-event-projector.test.ts`，期望事件顺序、原子边界和错误测试全部通过。

## T24：接入控制器命令与会话模式

**文件：** `src/chat/controller.ts`、`tests/integration/chat-controller.test.ts`

**依赖：** T3、T8、T23

**步骤：**
1. 在统一发送入口先解析命令。
2. `/plan` 只调用模式存储并更新状态，不创建模型请求。
3. `/do` 先切 execute；无计划时显示错误且不创建运行。
4. 有计划时以显示文本 `/do` 开始回合，并构造明确内部执行指令。
5. 会话切换恢复各自模式和计划引用。

**验证：** 运行 `npx --no-install vitest run tests/integration/chat-controller.test.ts -t "plan|do|模式|会话"`，期望命令和会话隔离测试通过。

## T25：控制器消费 Agent 事件并处理取消

**文件：** `src/chat/controller.ts`、`tests/integration/chat-controller.test.ts`

**依赖：** T18、T23、T24

**步骤：**
1. 普通消息原子开始回合，构造 AgentContext 并启动 Runner。
2. 顺序消费所有 AgentEvent，并逐个等待 Projector 完成。
3. 生成器、投影或存储失败时统一中断并发布真实错误。
4. Ctrl+C 同时取消 Runner、审批和工具，再等待最终投影收尾。
5. 删除控制器中的 s02 固定 initial/final 流程，并按留痕规则保留替换说明。
6. 在一个回合活跃时再次发送消息，确认第二次发送被拒绝且原回合不受破坏。

**验证：** 运行 `npx --no-install vitest run tests/integration/chat-controller.test.ts`，期望多迭代、取消、失败后继续发送和会话切换测试通过。

## T26：在组合根组装 s03 Agent 系统

**文件：** `src/cli/bootstrap.ts`、`src/tools/create-tool-system.ts`

**依赖：** T15、T18、T25

**步骤：**
1. 使用现有工具系统创建 ToolPolicy 所需注册中心、执行器和审批器。
2. 组装 StreamCollector、SafetyBatchScheduler 和 AgentRunner。
3. 把 Runner 和工具审批依赖注入 ChatController。
4. 保持每个 profile 独立 Provider/Repository，工作区工具系统仍在启动时固定捕获。
5. 移除未使用的 `void toolSystem` 临时语句。

**验证：** 运行 `npm run typecheck` 和 `npm run build`，期望均退出码 0，组合根无未使用依赖。

## T27：展示模式、迭代和回合 Token

**文件：** `src/tui/components/status-bar.tsx`、`src/tui/screens/chat-screen.tsx`、`tests/tui/chat-screen.test.tsx`、`tests/tui/app.test.tsx`

**依赖：** T22、T25

**步骤：**
1. 状态栏显示 `PLAN` 或 `DO`、活跃 `N/20`、阶段和累计 Token。
2. 空闲时保留最近完成回合的累计用量，下一回合开始时清零。
3. Agent 任一非终态阶段视为 busy；失败终态允许继续输入。
4. 保持 Ctrl+C、Y/N、会话切换和输入焦点行为。

**验证：** 运行 `npx --no-install vitest run tests/tui/chat-screen.test.tsx tests/tui/app.test.tsx -t "PLAN|DO|迭代|Token|取消"`，期望相关 TUI 测试通过。

## T28：展示独立迭代和新工具终态

**文件：** `src/tui/components/message-list.tsx`、`src/tui/components/tool-call-card.tsx`、`tests/tui/chat-screen.test.tsx`

**依赖：** T23、T27

**步骤：**
1. 按助手消息 ID 把每批工具卡片附到正确迭代。
2. 纯工具调用的空正文助手消息仍显示迭代及工具卡片。
3. 为模式不可用、迭代上限和 interrupted 提供可区分摘要。
4. 保持旧成功、失败、拒绝和超时状态显示。

**验证：** 运行 `npx --no-install vitest run tests/tui/chat-screen.test.tsx`，期望独立迭代和全部工具终态渲染测试通过。

## T29：集成验证自主循环与逐迭代持久化

**文件：** `tests/integration/agent-loop.test.ts`

**依赖：** T8、T18、T21、T25

**步骤：**
1. 构造三次响应：读取、根据结果继续调用、无工具最终回复。
2. 证明只发送一次用户消息便自动完成。
3. 验证三个助手迭代、工具结果上下文和每次用量。
4. 验证回合累计用量和重启后历史一致。
5. 增加第 20 次工具调用不执行的集成场景。
6. 增加读取、经批准修改、运行验证命令并自然完成的完整场景，同时覆盖拒绝后结果回写并继续。
7. 增加文件不存在或命令失败后模型改用其他工具并自然完成的调整场景。

**验证：** 运行 `npx --no-install vitest run tests/integration/agent-loop.test.ts`，期望自主循环、20 轮和持久化场景全部通过。

## T30：集成验证 Plan Mode 与 `/do`

**文件：** `tests/integration/plan-mode.test.ts`

**依赖：** T24、T29

**步骤：**
1. 验证 `/plan` 不请求模型，只公开三个只读工具。
2. 模拟 Plan Mode 返回写工具，确认无审批、无副作用且结果为模式不可用。
3. 自然完成计划后执行 `/do`，确认立即请求模型并提供全部六工具。
4. 无计划 `/do` 不请求模型。
5. 切换和重启两个会话，确认模式与计划隔离。

**验证：** 运行 `npx --no-install vitest run tests/integration/plan-mode.test.ts`，期望 Plan/Do 全流程通过。

## T31：集成验证模型流、审批和工具取消

**文件：** `tests/integration/agent-cancellation.test.ts`

**依赖：** T25、T29

**步骤：**
1. 在模型持续输出期间取消，验证部分正文和取消终态。
2. 在等待副作用审批时取消，验证无副作用且调用为 interrupted。
3. 在可中断工具执行期间取消，验证不进入后续段或迭代。
4. 确认已完成工具结果保持成功。
5. 每个场景后发送新消息，验证控制器恢复可用。

**验证：** 运行 `npx --no-install vitest run tests/integration/agent-cancellation.test.ts`，期望三个取消阶段和恢复发送全部通过。

## T32：集成验证进程中断恢复

**文件：** `tests/integration/agent-recovery.test.ts`

**依赖：** T8、T23

**步骤：**
1. 直接构造 running 回合、streaming 消息、pending 及 running 工具记录。
2. 重新初始化 Repository，验证全部转换为中断状态。
3. 验证 completed 消息、工具和历史计划不被覆盖。
4. 确认恢复不触发模型请求、审批或工具执行。

**验证：** 运行 `npx --no-install vitest run tests/integration/agent-recovery.test.ts`，期望中断恢复和无自动续跑测试通过。

## T33：完成三协议一致性与 s02 回归迁移

**文件：** `tests/integration/provider-streaming.test.ts`、`tests/integration/tool-turn.test.ts`、`tests/unit/providers/anthropic.test.ts`、`tests/unit/providers/openai-responses.test.ts`、`tests/unit/providers/openai-chat.test.ts`、`src/providers/types.ts`

**依赖：** T19、T20、T21、T29

**步骤：**
1. 对三种协议运行等价的两轮工具流并比较统一事件语义。
2. 将 s02 “一次回灌”测试改为“结果后可继续调用直到自然完成”。
3. 保留普通无工具、thinking、usage、错误和取消回归。
4. 按状态留痕要求保留 T1 的两阶段兼容字段和适配分支，但确认组合根不使用它们。
5. 搜索生产代码对 `phase: initial/final` 的使用，区分保留的兼容入口与 s03 活跃主流程。

**验证：** 运行 `npx --no-install vitest run tests/unit/providers tests/integration/provider-streaming.test.ts tests/integration/tool-turn.test.ts`，并运行 `rg -n "phase.*initial|phase.*final|toolHistory" src`；期望测试通过，搜索结果仅属于明确标注的旧兼容入口，组合根和 `AgentRunner` 主流程无匹配。

## T34：审计 s03 状态留痕和死代码边界

**文件：** 所有本阶段修改的 `src/**/*.ts`、`src/**/*.tsx`

**依赖：** T26、T28、T33

**步骤：**
1. 检查所有新解释性注释以 `[s03]` 开头。
2. 检查修改已有手写实现的位置保留旧状态标签和替换说明。
3. 确认 `ToolBatchCoordinator` 与 `ToolCallAssembler` 未被 s03 组合根或主流程引用。
4. 确认没有保留真实密钥、临时调试输出或无意的事件日志。
5. 对只因格式变化而产生的无意义改动进行回收。

**验证：** 运行 `rg -n "\[s03\]|s03 替换|ToolBatchCoordinator|ToolCallAssembler" src` 和 `npm run lint`，期望留痕可见、旧编排无主流程调用且 lint 退出码 0。

## T35：更新用户文档

**文件：** `AGENT.md`、`README.md`

**依赖：** T30、T31、T34

**步骤：**
1. 将当前状态更新为 s03，说明自主 Agent Loop 和每轮独立消息。
2. 说明 `/plan`、`/do`、会话持久化和无计划错误。
3. 说明 20 轮、三轮未知工具、取消、流错误等停止行为。
4. 说明只读并发、安全屏障和现有 Y/N 批准。
5. 删除 README 中与 s02 工具能力冲突的旧“不支持”描述。

**验证：** 运行 `rg -n "s03|Agent Loop|/plan|/do|20|未知工具|PLAN|DO|批准" AGENT.md README.md`，期望所有用户可见能力和边界均有说明。

## T36：执行完整自动验证并编写 s03 导读

**文件：** `Project_Guide/s03.md`、必要时修复本阶段相关源码与测试

**依赖：** T32、T33、T35

**步骤：**
1. 运行完整类型检查、lint、测试、覆盖率和生产构建。
2. 修复任何 s03 引入的失败并重跑相关验证，直到全部通过。
3. 运行构建后的 `--help` 冒烟测试。
4. 编写 s03 中文导读，说明架构、事件流、停止条件、Plan Mode、迁移、安全边界和实际自动验证结果。
5. 不把尚未执行的人工 Windows Terminal 场景写成已通过。

**验证：** 运行 `npm run check`、`npm run test:coverage` 和 `node dist/bin/mycode.js --help`；期望全部退出码 0，并在 `Project_Guide/s03.md` 记录真实文件数、测试数及未执行的人工项。

## 执行顺序

```text
T1 ─┬─→ T2 ─────────→ T11 → T12 ─┐
    ├─→ T4 → T5 → T6 → T7 → T8 ─┼─→ T22 → T23 ─┐
    ├─→ T9 ───────────────────────┤              │
    ├─→ T10 → T13 → T14 → T15 ───┼→ T16 → T17 → T18
    ├─→ T19（可与存储分支并行）───┤              │
    ├─→ T20（可与存储分支并行）───┤              │
    └─→ T21（可与存储分支并行）───┘              │
                                                   ↓
T3 ─────────────────────────────────────────────→ T24 → T25 → T26
                                                           ├→ T27 → T28
                                                           └→ T29 → T30
                                                                    ├→ T31
T8 + T23 ────────────────────────────────────────────────────────────└→ T32
T19 + T20 + T21 + T29 ───────────────────────────────────────────────→ T33
T26 + T28 + T33 ─────────────────────────────────────────────────────→ T34
T30 + T31 + T34 ─────────────────────────────────────────────────────→ T35
T32 + T33 + T35 ─────────────────────────────────────────────────────→ T36
```

允许并行的范围仅限依赖已经满足且修改文件不重叠的分支。Provider 三个适配器可以彼此并行；存储分支、命令解析、测试帮助器和纯 Agent 策略可在基础类型完成后并行。Controller、TUI、集成和最终文档阶段按图收敛串行执行。

当前目录没有 Git 元数据，因此任务中不安排提交步骤；若实施前恢复为 Git 工作树，再按逻辑任务组提交且不得混入无关改动。
