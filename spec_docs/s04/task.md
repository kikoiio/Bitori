# MyCode 结构化系统提示 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/prompt/builder.ts` | PromptBlock/PromptSection/SystemPrompt、优先级常量、buildSystemPrompt |
| 新建 | `src/prompt/sections.ts` | 七个固定模块中文正文常量、FIXED_SECTIONS 清单 |
| 新建 | `src/prompt/environment.ts` | EnvironmentInfo、collectEnvironment、环境模块渲染 |
| 新建 | `src/prompt/reminders.ts` | 标签常量、wrapSystemReminder、Plan 节奏与文案、buildReminders |
| 修改 | `src/providers/types.ts` | Usage 缓存字段、ModelReminderItem、ChatRequest.system |
| 修改 | `src/providers/anthropic.ts` | system 块数组、双 cache_control、缓存用量解析、reminder 分支 |
| 修改 | `src/providers/openai-chat.ts` | 首条 system 消息、reminder 分支 |
| 修改 | `src/providers/openai-responses.ts` | instructions 字段、reminder 分支 |
| 修改 | `src/agent/types.ts` | AgentRunInput 增加 system/reminders |
| 修改 | `src/agent/context.ts` | appendReminder |
| 修改 | `src/agent/runner.ts` | 接入 system 与 reminders |
| 修改 | `src/agent/stream-collector.ts` | 聚合缓存用量字段 |
| 修改 | `src/chat/agent-controller.ts` | 会话激活时构建冻结系统提示；Plan 轮次推导与提醒生成 |
| 修改 | `src/tui/components/status-bar.tsx` | 用量区追加缓存命中显示 |
| 修改 | `src/tools/implementations/`（六个文件） | 工具描述双重强化 |
| 新建 | `tests/unit/prompt/builder.test.ts` | 拼装顺序、空行分隔、可选模块扩展、确定性、长度上限 |
| 新建 | `tests/unit/prompt/sections.test.ts` | 三规则齐备、模块清单完整 |
| 新建 | `tests/unit/prompt/environment.test.ts` | 六字段采集与渲染 |
| 新建 | `tests/unit/prompt/reminders.test.ts` | 标签包装、Plan 节奏序列、模式切换 |
| 修改 | `tests/unit/providers/anthropic.test.ts` | system 块数组、cache_control 位置、缓存字段解析、reminder 渲染 |
| 修改 | `tests/unit/providers/openai-chat.test.ts` | system 首条消息、reminder 渲染 |
| 修改 | `tests/unit/providers/openai-responses.test.ts` | instructions、reminder 渲染 |
| 修改 | `tests/unit/agent/runner.test.ts` | system 透传、reminder 追加位置、缓存用量累计 |
| 修改 | `tests/integration/plan-mode.test.ts` | 5 轮节奏序列、/do 停止注入、再入重置、提醒不持久化 |
| 修改 | `tests/tui/`（状态栏相关用例） | cache 显示断言 |
| 新建 | `tests/acceptance/scenarios.md` | F15 人工定性场景集 |
| 新建 | `Project_Guide/s04.md` | s04 状态导读 |
| 修改 | `AGENT.md` | 当前状态与阶段描述更新为 s04 |

## T1: prompt 模块核心三文件

**文件：** `src/prompt/builder.ts`、`src/prompt/sections.ts`、`src/prompt/environment.ts`
**依赖：** 无
**说明：** 三文件互相引用构成一个编译单元，只有齐备后才能通过编译，故合并为一个任务。

**步骤：**
1. `builder.ts`：定义 `PromptBlock {text, cacheable}`、`PromptSection {id, priority, text}`、`SystemPrompt {blocks, text}`；定义优先级常量（身份 10、系统约束 20、任务模式 30、动作执行 40、工具使用 50、语气风格 60、文本输出 70、环境信息 80、自定义指令 90、Skill 100、长期记忆 110）。
2. `builder.ts`：实现 `buildSystemPrompt(env, optionalSections = [])`——取固定模块清单与环境模块，连同可选模块按优先级排序；七个固定模块以空行拼接为 `blocks[0]`（`cacheable: true`）；环境信息为 `blocks[1]`（`cacheable: false`）；可选模块各自成块追加（`cacheable: false`）；`text` 为全部块以空行连接。
3. `sections.ts`：按 plan.md「模块设计」中的内容要点撰写七个模块的中文正文常量（身份、系统约束、任务模式、动作执行、工具使用、语气风格、文本输出），导出 `FIXED_SECTIONS: PromptSection[]`；工具使用模块必须包含三条关键规则（优先专用工具、编辑前必先读取、路径先查证）和六工具一句话索引；全部正文总量控制在约 4000 字符以内。
4. `environment.ts`：定义 `EnvironmentInfo` 六字段；实现 `collectEnvironment(profile, workspaceRoot)`（OS 取自 `process.platform` 与 `os.release()`，Node 版本取自 `process.version`，日期为本地 `YYYY-MM-DD`）；实现环境模块文本渲染函数。
5. 三个文件的新注释均以 `[s04]` 开头。

**验证：** `npm run typecheck` 通过。

## T2: reminders.ts 提醒生成

**文件：** `src/prompt/reminders.ts`
**依赖：** 无（只引用 `agent/types.ts` 的 AgentMode）
**步骤：**
1. 定义 `<system-reminder>` 开闭标签常量与 `wrapSystemReminder(text)`。
2. 定义 `PLAN_FULL_INTERVAL = 3`。
3. 撰写 Plan 完整指令文案（处于 Plan 模式、只能只读探索、不得修改任何文件、最终产出计划供 `/do` 执行）与一行精简文案（重申 Plan 模式保持只读）。
4. 实现 `buildReminders(mode, turnIndex)`：`execute` 返回 `[]`；`plan` 且 `(turnIndex - 1) % PLAN_FULL_INTERVAL === 0` 返回完整文案（含标签）；其余返回精简文案（含标签）。
5. 注释以 `[s04]` 开头。

**验证：** `npm run typecheck` 通过；文件中可见标签常量、`PLAN_FULL_INTERVAL = 3` 与两段文案。

## T3: builder 单元测试

**文件：** `tests/unit/prompt/builder.test.ts`
**依赖：** T1
**步骤：**
1. 用固定 `EnvironmentInfo` 调用 `buildSystemPrompt`，断言 `text` 中七个模块标题按优先级顺序出现（用 `indexOf` 比较相对顺序），环境信息位于最后。
2. 断言相邻模块间以空行分隔（`\n\n`）。
3. 断言 `blocks` 结构：`blocks[0].cacheable === true`，`blocks[1].cacheable === false`。
4. 注册一个测试用可选模块（priority 90），断言其内容出现在环境信息之后，且未修改 builder 源码。
5. 相同输入两次调用结果逐字节相等（`toBe`）。
6. 断言 `blocks[0].text.length` 不超过约 4000 字符。

**验证：** `npx vitest run tests/unit/prompt/builder.test.ts` 通过。

## T4: sections 与 environment 单元测试

**文件：** `tests/unit/prompt/sections.test.ts`、`tests/unit/prompt/environment.test.ts`
**依赖：** T1
**步骤：**
1. `sections.test.ts`：断言 `FIXED_SECTIONS` 恰好七个模块、优先级严格递增且与 plan 定义的编号一致；工具使用模块正文包含「优先」「读取」「路径」三条规则的关键表述。
2. `environment.test.ts`：用构造的 profile 调用 `collectEnvironment`，断言六字段齐备且类型正确；渲染文本包含工作区路径与模型名。

**验证：** `npx vitest run tests/unit/prompt` 通过。

## T5: reminders 单元测试

**文件：** `tests/unit/prompt/reminders.test.ts`
**依赖：** T2
**步骤：**
1. 断言 `buildReminders('execute', 1)` 返回空数组。
2. 断言 plan 模式第 1–5 轮返回序列：完整、精简、精简、完整、精简（通过文案特征区分完整与精简）。
3. 断言所有返回文本均被 `<system-reminder>` 标签包裹。
4. 断言精简文案为单行。

**验证：** `npx vitest run tests/unit/prompt/reminders.test.ts` 通过。

## T6: providers/types.ts 类型扩展

**文件：** `src/providers/types.ts`
**依赖：** T1（`ChatRequest.system` 引用 `prompt/builder.ts` 的 PromptBlock）
**步骤：**
1. `Usage` 增加可选字段 `cacheReadInputTokens?: number`、`cacheCreationInputTokens?: number`（`[s04]` 注释）。
2. 新增 `ModelReminderItem {type: 'reminder'; text: string}`，并入 `ModelContextItem` 联合。
3. `ChatRequest` 增加 `system?: PromptBlock[]`（从 `prompt/builder.ts` 导入类型），注明缺省时行为与 s03 一致。

**验证：** `npm run typecheck` 通过。

## T7: anthropic.ts 缓存与 system 映射

**文件：** `src/providers/anthropic.ts`
**依赖：** T6
**步骤：**
1. `AnthropicEvent` 的 usage 接口增加 `cache_creation_input_tokens?: number`、`cache_read_input_tokens?: number`。
2. `message_start` 分支把两个缓存字段映射进 `usage` 事件（仅当存在时加入）。
3. 请求参数增加 `system`：`request.system` 各块映射为 `{type:'text', text, ...(cacheable ? {cache_control:{type:'ephemeral'}} : {})}`；无 `request.system` 时不加该字段。
4. tools 映射：末位工具追加 `cache_control: {type:'ephemeral'}`。
5. items 转换链在 `else`（tool_results）分支之前增加 `item.type === 'reminder'` 显式分支，渲染为 `{role:'user', content: item.text}`。
6. 被替换的 s01 代码按留痕规则保留块注释并写明替换关系；新注释以 `[s04]` 开头。

**验证：** `npm run typecheck` 通过；`npx vitest run tests/unit/providers/anthropic.test.ts` 既有用例通过。

## T8: openai-chat.ts system 消息与 reminder 分支

**文件：** `src/providers/openai-chat.ts`
**依赖：** T6
**步骤：**
1. messages 数组构造完成后，若 `request.system` 存在，将全部块文本以空行拼接，在数组开头 unshift `{role:'system', content}`。
2. items 转换链增加 `reminder` 显式分支，渲染为 `{role:'user', content: item.text}`。
3. 留痕块注释与新 `[s04]` 注释。

**验证：** `npm run typecheck` 通过；`npx vitest run tests/unit/providers/openai-chat.test.ts` 既有用例通过。

## T9: openai-responses.ts instructions 与 reminder 分支

**文件：** `src/providers/openai-responses.ts`
**依赖：** T6
**步骤：**
1. 请求参数增加 `instructions`：`request.system` 全部块文本以空行拼接；无 `request.system` 时不加该字段。
2. items 转换链增加 `reminder` 显式分支，渲染为 `{role:'user', content: item.text}`。
3. 留痕块注释与新 `[s04]` 注释。

**验证：** `npm run typecheck` 通过；`npx vitest run tests/unit/providers/openai-responses.test.ts` 既有用例通过。

## T10: anthropic provider 测试

**文件：** `tests/unit/providers/anthropic.test.ts`
**依赖：** T7
**步骤：**
1. 构造带 `system` 两块的请求，断言 SDK 收到的 `system` 为块数组：稳定块含 `cache_control:{type:'ephemeral'}`，环境块不含。
2. 断言 tools 数组仅末位工具含 `cache_control`。
3. 模拟 `message_start` usage 携带缓存字段，断言 `usage` 事件包含对应数值。
4. 构造含 reminder 项的 items，断言渲染为用户角色消息且内容原样（含标签）。
5. 无 `system` 的旧式请求断言参数不含 `system` 字段（回归）。

**验证：** `npx vitest run tests/unit/providers/anthropic.test.ts` 通过。

## T11: openai 两 provider 测试

**文件：** `tests/unit/providers/openai-chat.test.ts`、`tests/unit/providers/openai-responses.test.ts`
**依赖：** T8、T9
**步骤：**
1. openai-chat：断言带 `system` 的请求首条消息为 `{role:'system'}` 且内容为块拼接；reminder 项渲染为用户消息；无 `system` 时无 system 消息（回归）。
2. openai-responses：断言带 `system` 的请求含 `instructions` 字段且内容为块拼接；reminder 项渲染为用户角色 input；无 `system` 时无 `instructions`（回归）。

**验证：** `npx vitest run tests/unit/providers` 通过。

## T12: agent 层类型与上下文扩展

**文件：** `src/agent/types.ts`、`src/agent/context.ts`
**依赖：** T1（AgentRunInput 引用 PromptBlock）、T6（appendReminder 引用 ModelReminderItem）
**步骤：**
1. `AgentRunInput` 增加 `system?: PromptBlock[]`、`reminders?: string[]`（`[s04]` 注释）。
2. `AgentContext` 增加 `appendReminder(item: ModelReminderItem): void`，追加到 items 末尾。

**验证：** `npm run typecheck` 通过。

## T13: runner 接入 system 与 reminders

**文件：** `src/agent/runner.ts`
**依赖：** T12
**步骤：**
1. 回合上下文初始化后，把 `input.reminders ?? []` 逐条包装为 `{type:'reminder', text}` 追加到 context。
2. 每次迭代的 `streamChat` 调用携带 `system: input.system`。
3. 累计 `total` 时同步累计两个缓存字段（沿用现有的有值才覆盖语义）。
4. 新注释以 `[s04]` 开头。

**验证：** `npm run typecheck` 通过；`npx vitest run tests/unit/agent/runner.test.ts` 既有用例通过。

## T14: stream-collector 缓存用量聚合

**文件：** `src/agent/stream-collector.ts`
**依赖：** T6
**步骤：**
1. usage 聚合对象与 `usage_updated` 事件负载增加两个缓存字段，沿用现有 `||` 保留语义（后续事件缺字段时不清空已收到的值）。

**验证：** `npm run typecheck` 通过。

## T15: runner 与 collector 测试

**文件：** `tests/unit/agent/runner.test.ts`
**依赖：** T13、T14
**步骤：**
1. 用 mock LLM client 断言每次 `streamChat` 收到的 `system` 与 run 输入一致。
2. 传入两条 reminders，断言首轮请求 items 中 reminder 项位于最后一条用户消息之后、顺序保持。
3. 模拟 usage 事件携带缓存字段，断言 `usage_updated` 事件与回合 `totalUsage` 均包含累计缓存数值。

**验证：** `npx vitest run tests/unit/agent/runner.test.ts` 通过。

## T16: agent-controller 系统提示冻结与提醒注入

**文件：** `src/chat/agent-controller.ts`
**依赖：** T1、T2、T13
**步骤：**
1. 新增私有字段保存冻结的系统提示（`PromptBlock[]`）。
2. 新增私有方法：`collectEnvironment(profile, process.cwd())` → `buildSystemPrompt(env)` → 存入字段。
3. `initialize`、`createSession`、`switchSession` 三处调用重建方法。
4. `#startRun`：从 `conversation.agentRuns` 计算 Plan 轮次——当前模式为 `plan` 时，取尾部连续 `mode === 'plan'` 的 run 数 + 1；当前模式为 `execute` 时轮次为 0。
5. `buildReminders(mode, planTurnIndex)` 的结果随 `runner.run` 输入传入。
6. 新注释以 `[s04]` 开头。

**验证：** `npm run typecheck` 通过；`npx vitest run tests/integration/chat-controller.test.ts` 既有用例通过。

## T17: plan-mode 集成测试（节奏与不持久化）

**文件：** `tests/integration/plan-mode.test.ts`
**依赖：** T16
**步骤：**
1. 新会话 `/plan` 后连续发起 5 个用户回合，用 mock client 记录每次请求，断言第 1、4 轮注入完整文案、第 2、3、5 轮注入精简文案（reminder 项位于请求 items 末尾）。
2. `/do` 后断言请求不再携带 reminder 项。
3. 再次 `/plan` 后第 1 轮断言重新注入完整文案。
4. 通过 repository 读取持久化消息，断言任何消息正文都不含 `<system-reminder>`。
5. 既有 plan-mode 用例保持通过（必要时按新行为调整预期）。

**验证：** `npx vitest run tests/integration/plan-mode.test.ts` 通过。

## T18: 状态栏缓存命中显示

**文件：** `src/tui/components/status-bar.tsx`、`tests/tui/`（状态栏所在测试文件）
**依赖：** T6、T14
**步骤：**
1. 用量区在 `tokens X↓ Y↑` 后追加 ` · cache N`：N 取当前显示用量（runUsage 优先逻辑不变）的 `cacheReadInputTokens`，仅在数值大于 0 时显示。
2. 在状态栏相关 TUI 测试中补充：有缓存命中时显示 `cache`，无时保持原样。
3. 新注释以 `[s04]` 开头。

**验证：** `npx vitest run tests/tui` 通过。

## T19: 六工具描述双重强化

**文件：** `src/tools/implementations/read-file.ts`、`write-file.ts`、`edit-file.ts`、`run-command.ts`、`find-files.ts`、`search-text.ts`
**依赖：** 无
**步骤：**
1. `edit_file.ts`：描述补充「编辑任何文件前必须先用 read_file 读取该文件」。
2. `run_command.ts`：描述补充「能用专用工具（read_file、write_file、edit_file、find_files、search_text）完成的操作优先使用专用工具」。
3. `find_files.ts`、`search-text.ts`：描述补充「确定文件路径或位置前先用本工具查证，不要猜测」。
4. `read_file.ts`、`write_file.ts`：描述与上述规则呼应（read_file 强调是编辑前必读入口；write_file 说明用于新建或整文件写入）。
5. 每个文件：旧描述按 `/* [s0X 旧实现，s04 替换] ... */` 形式就近保留块注释；新描述注释以 `[s04]` 开头；参数、能力、限制不变。

**验证：** `npm run typecheck` 通过；`npx vitest run tests/unit/tools` 通过；六个描述均可 grep 到对应规则表述。

## T20: 人工定性场景集

**文件：** `tests/acceptance/scenarios.md`
**依赖：** 无（内容可在开发早期撰写，验收阶段使用）
**步骤：**
1. 场景一「读取后编辑」：要求模型修改一个已存在文件；观察是否先 read_file 再 edit_file；写明 s03（无系统提示）与 s04 的预期差异。
2. 场景二「专用工具优先」：提出可用专用工具完成的任务；观察是否避免 run_command 调 shell。
3. 场景三「Plan 模式只读」：`/plan` 后提交修改类任务；观察模型是否只用只读工具、是否产出计划；连续多轮观察提醒注入节奏（配合日志或请求记录）。
4. 场景四「输出风格」：普通问答；观察回复是否为简洁中文、Markdown、代码块带语言标记。
5. 每个场景写明：目的、前置条件、操作步骤、观察点、s03 预期、s04 预期。

**验证：** 文档存在，四场景齐备，每个场景含操作步骤与观察点。

## T21: 全量检查与修复

**文件：** 全项目
**依赖：** T1–T20
**步骤：**
1. 运行 `npm run check`（typecheck + lint + 全部测试 + 构建）。
2. 修复任何失败项并复跑，直到全绿。

**验证：** `npm run check` 全部通过。

## T22: 状态留痕文档

**文件：** `Project_Guide/s04.md`、`AGENT.md`
**依赖：** T21
**步骤：**
1. 按 s01–s03 导读格式撰写 `Project_Guide/s04.md`：本状态目标、系统提示结构、缓存与注入机制、文件变化清单、验证结论。
2. `AGENT.md`：当前状态标记更新为 `s04`，「当前阶段」一节追加 s04 要点（结构化系统提示、缓存通道、提醒注入、Plan 节奏）；不改动 s01–s03 历史描述。

**验证：** 两份文档存在且内容对应；`AGENT.md` 当前状态为 `s04`。

## 执行顺序

```
T1 ──→ T3 ──→ T4 ──→ T5
 │      （T3–T5 为 prompt 测试）
T2 ──┘（T2 独立，可与 T1 并行；T5 依赖 T2）

T1 ──→ T6 ──→ T7 ──→ T10
        ├────→ T8 ──→ T11
        └────→ T9 ──┘
（T10/T11 为 provider 测试）

T1,T6 ──→ T12 ──→ T13 ──→ T15
T6 ──→ T14 ──┘
T1,T2,T13 ──→ T16 ──→ T17
T6,T14 ──→ T18

T19、T20 全程独立，可随时插入

全部完成 ──→ T21 ──→ T22
```
