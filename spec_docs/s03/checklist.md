# MyCode Agent Loop Checklist

> 每一项只依据实际命令输出或可观察行为标记。自动验证与真实 Windows Terminal 场景分开记录；未配置真实 API Key 时，不把人工供应商场景写成通过。

## 收尾验收结论（2026-08-23）

结论：按“保留每个阶段代码”的项目要求，s03 **基本完成**。主流程、自动质量入口和一个真实 DeepSeek Anthropic 兼容端点已经贯通；未把旧阶段兼容入口删除，也没有冒充完成三个官方供应商端点的分别实测。

### 自动验收

- [x] 自主多轮、独立迭代、20 轮上限、连续三轮未知工具和异常流停止（证据：`tests/unit/agent/runner.test.ts` 4 项通过）。
- [x] Plan/Do、只读定义、越权拦截、最近计划执行和无计划错误（证据：`tests/integration/plan-mode.test.ts` 2 项通过）。
- [x] 多轮工具回写、逐项批准/拒绝和结果驱动调整（证据：`tests/integration/tool-turn.test.ts` 4 项通过）。
- [x] 模型流取消、审批取消和取消后恢复发送（证据：`tests/integration/agent-cancellation.test.ts` 2 项通过）。
- [x] 非终态进程恢复为中断且不续跑（证据：`tests/integration/agent-recovery.test.ts` 1 项通过）。
- [x] 数据库版本 3、真实 Worker 往返和旧工具持久化回归（证据：完整测试套件通过）。
- [x] 重启和切换会话后恢复最近一次迭代、累计 Token 与停止原因（验收中发现缺陷后修复；证据：`tests/integration/chat-controller.test.ts`）。
- [x] `npm run check`（证据：typecheck、lint、45 个测试文件/137 个测试项、生产构建全部退出码 0）。
- [x] `npm run test:coverage`（证据：45/45 文件、137/137 测试通过；整体语句 62.14%，Agent 目录语句 91.4%）。
- [x] `node dist/bin/mycode.js --help`（证据：显示用法并退出码 0）。
- [x] 架构静态检查（证据：Provider 不运行 SDK 自动工具循环；Agent 核心无 TUI、React、Ink 或仓储实现依赖；组合根使用 `AgentRunner`）。
- [x] s01/s02 兼容字段与 `LegacyChatController` 保留（这是用户确认的阶段留痕要求，不再作为清理缺口；生产组合根不使用旧控制器）。

### 真实 DeepSeek 终端验收

- [x] PLAN 中读取文件并产出计划，未发生写入；`/do` 自动执行最近计划。
- [x] 写入和命令逐项等待 `Y/N`；批准后自动续跑，拒绝后结果回写且文件不变。
- [x] 命令失败后模型读取结果、改用适合 PowerShell 的命令并自然完成。
- [x] 模型流期间 `Ctrl+C` 安全停止，随后新消息正常得到回复。
- [x] 审批等待期间 `Ctrl+C` 标记中断且无副作用；按 `N` 后模型可继续。
- [x] 运行中命令 `Ctrl+C` 可终止子进程；等待超过原命令时长后目标文件仍不存在。
- [x] PLAN/DO 在不同会话间隔离，切换和重启后模式保持；无计划 `/do` 不调用 API。
- [x] 重启后历史、工具结果和 Token 恢复；验收发现的 Token 归零问题已增加回归测试并修复。
- [ ] 官方 Anthropic、OpenAI Responses、OpenAI Chat 原生端点分别实测。本次仅验证了 DeepSeek 的 Anthropic 兼容端点，不外推为三端点全部通过。

> 下方“实现完整性”等条目保留为 s03 最初的严格验收基线。其中部分命令引用了最终未单独落盘的计划测试文件，不能逐项机械标记为通过；本次收尾以以上真实存在的 137 项自动测试、静态检查和真实终端行为为准。

## 实现完整性

- [ ] **AC1 — 自主完成多轮任务：** 运行 `npx --no-install vitest run tests/integration/agent-loop.test.ts -t "自主循环"`；期望只发送一次用户消息，模型经历至少两批工具并在无工具响应时自动完成。
- [ ] **AC2 — 每次迭代独立成消息：** 运行 `npx --no-install vitest run tests/integration/agent-loop.test.ts -t "独立迭代"`；期望三次模型响应形成三条顺序正确的助手消息，纯工具迭代即使正文为空也被保存，重启后保持一致。
- [ ] **AC3 — 20 轮安全上限：** 运行 `npx --no-install vitest run tests/unit/agent/runner.test.ts tests/integration/agent-loop.test.ts -t "20|迭代上限"`；期望最多请求模型 20 次，第 20 次提出的调用不进入审批或执行，并以 iteration_limit 停止。
- [ ] **AC4 — 模型流期间取消：** 运行 `npx --no-install vitest run tests/integration/agent-cancellation.test.ts -t "模型流"`；期望部分正文保存为取消状态，不启动工具或下一迭代，随后可以发送新任务。
- [ ] **AC5 — 审批和工具阶段取消：** 运行 `npx --no-install vitest run tests/integration/agent-cancellation.test.ts -t "审批|工具执行"`；期望已完成结果保持成功，待审批、运行中和未开始调用进入 interrupted，循环不再推进。
- [ ] **AC6 — 连续未知工具保护：** 运行 `npx --no-install vitest run tests/unit/agent/runner.test.ts -t "未知工具"`；期望前两次全未知结果回写，第三次后停止且无第四次请求；插入已注册调用后计数清零。
- [ ] **AC7 — 模型流错误停止：** 运行 `npx --no-install vitest run tests/unit/agent/stream-collector.test.ts tests/unit/agent/runner.test.ts -t "显式错误|意外结束|流错误"`；期望部分内容和实际用量保留，当前迭代及回合失败，不执行不完整调用且不自动重试。
- [ ] **AC8 — 流式双路收集：** 运行 `npx --no-install vitest run tests/unit/agent/stream-collector.test.ts -t "实时|完整"`；期望流尚未结束时消费者已收到文本、思考和参数事件，结束值包含无重复遗漏的完整响应。
- [ ] **AC9 — 进度和稳定关联：** 运行 `npx --no-install vitest run tests/unit/agent/runner.test.ts tests/unit/chat/agent-event-projector.test.ts -t "进度|关联|事件顺序"`；期望可观察回合、迭代、审批、工具进度和停止原因，所有事件能按稳定 ID 关联。
- [ ] **AC10 — 顺序安全屏障：** 运行 `npx --no-install vitest run tests/unit/agent/safety-batch-scheduler.test.ts -t "并发|屏障"`；期望连续读取实际重叠，写入等待前批，后续读取等待写入，命令最后串行执行。
- [ ] **AC11 — 批次失败隔离：** 运行 `npx --no-install vitest run tests/unit/agent/safety-batch-scheduler.test.ts -t "隔离|排序|拒绝|超时"`；期望一项失败不遗漏其他合法调用，最终结果数量完整并按模型原始位置回写。
- [ ] **AC12 — `/plan` 进入只读模式：** 运行 `npx --no-install vitest run tests/integration/plan-mode.test.ts -t "进入 Plan"`；期望 `/plan` 本身不请求模型，后续任务只获得 read_file、find_files 和 search_text，并仍可多轮运行。
- [ ] **AC13 — Plan Mode 越权保护：** 运行 `npx --no-install vitest run tests/integration/plan-mode.test.ts -t "模式不可用|越权"`；期望写入或命令不进入审批、不产生副作用，返回模式不可用结果且不增加全未知计数。
- [ ] **AC14 — `/do` 立即执行最近计划：** 运行 `npx --no-install vitest run tests/integration/plan-mode.test.ts -t "执行最近计划"`；期望无需额外消息便启动执行回合，模型看到最近计划和全部六个工具，会话保持 DO 模式。
- [ ] **AC15 — 无计划 `/do`：** 运行 `npx --no-install vitest run tests/integration/plan-mode.test.ts -t "没有可执行计划"`；期望显示明确错误，不请求模型、不创建 Agent 回合且不产生副作用。
- [ ] **AC16 — 模式和计划按会话恢复：** 运行 `npx --no-install vitest run tests/integration/plan-mode.test.ts -t "切换|重启|隔离"`；期望两个会话分别恢复自己的 PLAN/DO 状态及最新计划，不互相串用。
- [ ] **AC17 — 逐迭代和累计 Token：** 运行 `npx --no-install vitest run tests/integration/agent-loop.test.ts -t "Token|用量"`；期望每条助手消息保存自身输入、输出 Token，回合累计等于各次之和，重启后数值一致。
- [ ] **AC18 — 批准或拒绝后自动续跑：** 运行 `npx --no-install vitest run tests/integration/agent-loop.test.ts -t "批准|拒绝|续跑"`；期望批准前无副作用，决定后无需新用户消息便把结果回写并进入下一迭代。
- [ ] **AC19 — 三协议一致：** 运行 `npx --no-install vitest run tests/unit/providers tests/integration/provider-streaming.test.ts`；期望 Anthropic、OpenAI Responses 和 OpenAI Chat 对等场景产生相同语义的上下文顺序、工具事件、结果和停止行为。
- [ ] **AC20 — s01/s02 回归：** 运行 `npx --no-install vitest run tests/unit tests/integration tests/tui`；期望普通对话、thinking、会话、工作区边界、UTF-8、六个工具、审批、取消和持久化测试全部通过。
- [ ] **AC21 — Plan 到执行完整自动流程：** 运行 `npx --no-install vitest run tests/integration/plan-mode.test.ts -t "端到端"`；期望 `/plan`、多文件读取、最终计划、`/do`、写入审批、测试命令和无工具最终回复完整贯通。

## 架构与集成

- [ ] **Agent 核心与界面解耦：** 运行 `rg -n "SessionRepository|AppState|from .*tui|from .*chat|react|ink" src/agent`；期望无运行时界面或仓储实现依赖，随后运行 `npm run typecheck` 退出码 0。
- [ ] **事件背压形成持久化屏障：** 运行 `npx --no-install vitest run tests/unit/chat/agent-event-projector.test.ts -t "持久化屏障|原子"`；期望工具副作用只在迭代消息和调用批次成功写盘后开始。
- [ ] **有序工具上下文：** 运行 `npx --no-install vitest run tests/unit/agent/context.test.ts`；期望每个助手调用后紧跟对应结果，多批结果不会被堆到错误位置。
- [ ] **Provider 不执行自动循环：** 运行 `rg -n "runTools|toolRunner|beta\.messages\.tool|auto.*tool" src/providers`；期望无 SDK 自动工具循环调用，并由 AgentRunner 成为唯一循环入口。
- [ ] **s02 两阶段主流程已断开：** 运行 `rg -n "phase.*initial|phase.*final|toolHistory|new ToolBatchCoordinator|new ToolCallAssembler" src --glob '!src/tools/batch-coordinator.ts' --glob '!src/tools/call-assembler.ts'`；期望无生产主流程匹配。
- [ ] **只允许一个活跃用户回合：** 运行 `npx --no-install vitest run tests/integration/chat-controller.test.ts -t "已有请求|活跃回合"`；期望第二次并发发送被拒绝且第一回合不受破坏。
- [ ] **旧数据库安全升级：** 运行 `npx --no-install vitest run tests/unit/storage/migrations.test.ts tests/integration/storage-worker.test.ts -t "升级|版本 3|旧数据"`；期望 s01/s02 数据不被伪造或丢失，新会话默认 DO 模式。
- [ ] **非终态恢复不续跑：** 运行 `npx --no-install vitest run tests/integration/agent-recovery.test.ts`；期望运行、消息和工具准确中断，不触发模型、审批或工具。
- [ ] **存储失败隔离：** 运行 `npx --no-install vitest run tests/unit/chat/agent-event-projector.test.ts -t "存储失败"`；期望不发布虚假成功、不继续副作用，并保留可见错误。
- [ ] **事件不包含配置密钥：** 运行 `npx --no-install vitest run tests/unit/config/secrets.test.ts tests/unit/agent/runner.test.ts -t "密钥|事件"`；期望配置密钥只存在于 Provider 配置边界，序列化 AgentEvent 不含测试密钥。
- [ ] **工作区和工具限制保持：** 运行 `npx --no-install vitest run tests/unit/tools tests/integration/tool-turn.test.ts`；期望路径边界、超时、截断、UTF-8 和六工具行为全部通过。
- [ ] **状态留痕完整：** 运行 `rg -n "\[s03\]|s03 替换" src AGENT.md Project_Guide/s03.md`；期望新实现和替换点有 s03 标识，且 s01/s02 导读及 spec 文件仍存在。

## 编译与测试

- [ ] **TypeScript 严格检查：** 运行 `npm run typecheck`；期望退出码 0。
- [ ] **ESLint：** 运行 `npm run lint`；期望退出码 0 且无错误。
- [ ] **全部自动测试：** 运行 `npm test`；期望全部测试文件和测试项通过，退出码 0。
- [ ] **覆盖率运行：** 运行 `npm run test:coverage`；期望退出码 0，报告包含新增 Agent、Projector、Scheduler 和存储代码，无测试执行失败。
- [ ] **生产构建：** 运行 `npm run build`；期望退出码 0 并生成可运行的 `dist/`。
- [ ] **完整质量入口：** 运行 `npm run check`；期望 typecheck、lint、test 和 build 全部通过。
- [ ] **CLI 冒烟：** 运行 `node dist/bin/mycode.js --help`；期望显示 MyCode 用法并以退出码 0 结束，不读取 API Key 或启动 TUI。
- [ ] **文档一致：** 运行 `rg -n "s03|Agent Loop|/plan|/do|20|未知工具|PLAN|DO|批准" AGENT.md README.md Project_Guide/s03.md`；期望当前能力、停止条件、安全边界和未执行人工项均有一致说明。

## 自动端到端场景

- [ ] **场景 A — 读取、修改、验证后完成：** 运行 `npx --no-install vitest run tests/integration/agent-loop.test.ts -t "读取.*修改.*验证"`；期望一次用户消息触发读取、经批准修改、运行验证命令并输出最终答复，所有迭代和结果可恢复。
- [ ] **场景 B — 混合工具安全顺序：** 运行 `npx --no-install vitest run tests/unit/agent/safety-batch-scheduler.test.ts -t "读.*写.*读.*命令"`；期望读取并发仅发生在同一连续段，副作用严格串行并形成屏障。
- [ ] **场景 C — 连续错误仍可调整：** 运行 `npx --no-install vitest run tests/integration/agent-loop.test.ts -t "失败后调整"`；期望文件不存在或命令失败结果回写后，模型可调用其他工具并自然完成，应用不退出。
- [ ] **场景 D — 取消后恢复：** 运行 `npx --no-install vitest run tests/integration/agent-cancellation.test.ts`；期望三种取消阶段均安全停止，随后新任务可正常完成。
- [ ] **场景 E — Plan 到 Do：** 运行 `npx --no-install vitest run tests/integration/plan-mode.test.ts -t "端到端"`；期望计划期无副作用，`/do` 后逐项批准并自动执行到自然完成。

## Windows Terminal 人工端到端

- [x] **真实 DeepSeek Anthropic 兼容 Plan/Do：** 已完成计划只读、`/do`、写入与命令审批、失败调整和自然完成。
- [x] **真实 DeepSeek 流式取消、审批取消/拒绝、工具执行取消：** 三个阶段均安全停止或继续，未批准副作用未发生，取消后可继续对话。
- [x] **真实 DeepSeek 会话恢复：** PLAN/DO 会话隔离；切换和进程重启后模式、历史及 Token 恢复。

- [ ] **真实 Anthropic Plan/Do：** 在 Windows Terminal PowerShell 运行 `npm run dev -- --profile <anthropic-profile>`，输入 `/plan`，再要求读取工作区并制定一个小改动计划，确认状态栏为 PLAN 且没有写入审批；输入 `/do` 后批准写入和验证命令，期望自动循环至最终答复并显示多条助手迭代。
- [ ] **真实 OpenAI Responses Plan/Do：** 使用 Responses profile 重复同一流程；期望没有重复文本或 function call，重启并恢复会话后历史、工具结果和累计 Token 一致。
- [ ] **真实 OpenAI Chat Plan/Do：** 使用 Chat Completions profile 重复同一流程；期望 assistant tool_calls 与 tool results 顺序正确，批准后自动继续。
- [ ] **真实流式取消：** 在任一真实 profile 输出长回答时按 `Ctrl+C`；期望部分回答保留、状态恢复空闲、没有后续工具或迭代，再发送普通消息可继续对话。
- [ ] **真实审批取消和拒绝：** 让模型请求一个无害的工作区写入；分别在审批时按 `Ctrl+C` 和按 `N`，期望前者中断整个回合、后者把拒绝结果回写并允许模型继续，文件均未被创建。
- [ ] **真实会话模式恢复：** 建立一个 PLAN 会话和一个 DO 会话，使用 `Ctrl+O` 切换并重启 MyCode；期望各自模式和最近计划保持独立。
- [ ] **终端响应性：** 在多轮读取和命令输出期间滚动消息、切换焦点并观察状态栏；期望文本持续流式刷新、键盘输入和取消无明显冻结。
