# MyCode 结构化系统提示 Plan

## 架构概览

```
┌─ src/prompt/（新建，系统提示唯一构建处）────────────────┐
│  sections.ts    七个固定模块的中文正文常量与优先级         │
│  environment.ts 采集环境信息（会话激活时冻结）             │
│  builder.ts     按优先级拼装 Section → PromptBlock[]      │
│  reminders.ts   <system-reminder> 包装 + Plan 节奏文案    │
└──────────────────────┬───────────────────────────────┘
                       │ buildSystemPrompt / buildReminders
┌─ src/chat/ ──────────▼───────────────────────────────┐
│  agent-controller.ts  会话激活时构建并冻结系统提示；      │
│                       发起回合时推导 Plan 轮次、生成提醒  │
└──────────────────────┬───────────────────────────────┘
                       │ AgentRunInput{system, reminders}
┌─ src/agent/ ─────────▼───────────────────────────────┐
│  runner.ts    把 system 传入每次模型请求；回合开始时     │
│               把 reminders 追加为 reminder 上下文项      │
│  context.ts   新增 appendReminder                     │
│  stream-collector.ts  聚合带缓存字段的 usage            │
└──────────────────────┬───────────────────────────────┘
                       │ ChatRequest{system, items 含 reminder}
┌─ src/providers/ ─────▼───────────────────────────────┐
│  anthropic.ts        system 块数组 + 双 cache_control   │
│                      + 缓存用量解析 + reminder 显式分支  │
│  openai-chat.ts      首条 system 消息 + reminder 分支   │
│  openai-responses.ts instructions 字段 + reminder 分支  │
└──────────────────────┬───────────────────────────────┘
                       │ usage 事件（含缓存字段）
┌─ src/tui/ ───────────▼───────────────────────────────┐
│  status-bar.tsx  现有用量旁追加缓存命中显示             │
└──────────────────────────────────────────────────────┘
```

- **prompt 模块**是系统提示的唯一构建处，向上只暴露 `buildSystemPrompt`、`buildReminders`、`collectEnvironment` 与相关类型。
- **chat 层**决定「什么时候构建、注入什么」：会话激活时构建冻结系统提示，发起回合时推导 Plan 轮次并生成提醒。
- **agent 层**只负责传递：把 system 放进每次请求，把 reminders 追加为上下文项，不解读内容。
- **providers 层**把中立结构映射为协议格式；缓存标记与缓存用量字段只存在于 Anthropic 映射中。
- 旧 s01/s02 控制路径（chat/controller.ts、turn-orchestrator.ts）不接入系统提示，保持原样；只有 s03 的 AgentRunner 主流程接入。

## 核心数据结构

### PromptBlock / PromptSection / SystemPrompt（src/prompt/builder.ts）

```ts
/** [s04] 一段可独立形成缓存边界的系统提示文本。 */
interface PromptBlock { text: string; cacheable: boolean }

/** [s04] 一个按优先级参与拼装的提示模块；可选模块也经此注册。 */
interface PromptSection { id: string; priority: number; text: string }

/** [s04] 构建结果：blocks 供 provider 映射缓存边界；text 供测试与快照断言。 */
interface SystemPrompt { blocks: PromptBlock[]; text: string }
```

优先级常量（间距预留插位，新增模块不动现有编号）：身份 10、系统约束 20、任务模式 30、动作执行 40、工具使用 50、语气风格 60、文本输出 70、环境信息 80、自定义指令 90、Skill 100、长期记忆 110。

拼装产物结构：`blocks[0]` = 七个固定模块以空行拼接，`cacheable: true`；`blocks[1]` = 环境信息，`cacheable: false`；可选模块各自成块追加在后，`cacheable: false`。`text` 为全部块以空行连接，供断言。

### EnvironmentInfo（src/prompt/environment.ts）

```ts
interface EnvironmentInfo {
  workspaceRoot: string; os: string; nodeVersion: string;
  date: string;            // YYYY-MM-DD，会话激活时冻结
  profileName: string; model: string;
}
collectEnvironment(profile: ProviderProfile, workspaceRoot: string): EnvironmentInfo
```

### 主入口签名

```ts
// src/prompt/builder.ts
buildSystemPrompt(env: EnvironmentInfo, optionalSections?: PromptSection[]): SystemPrompt

// src/prompt/reminders.ts
buildReminders(mode: AgentMode, turnIndex: number): string[]
// turnIndex 从 1 开始；execute 模式返回空数组；plan 模式返回 1 条带标签文本（完整或精简）
```

### providers/types.ts 扩展

```ts
interface Usage {
  inputTokens: number; outputTokens: number;
  cacheReadInputTokens?: number;      // [s04] 仅 Anthropic 上报
  cacheCreationInputTokens?: number;  // [s04] 仅 Anthropic 上报
}

/** [s04] 请求级补充指令；provider 渲染为用户角色消息，文本已含标签。 */
interface ModelReminderItem { type: 'reminder'; text: string }
type ModelContextItem = ModelMessageItem | ModelAssistantIterationItem
                      | ModelToolResultsItem | ModelReminderItem

interface ChatRequest {
  system?: PromptBlock[];   // [s04] 新增；缺省时行为与 s03 完全一致
  // …其余字段不变
}
```

### agent 层扩展

```ts
// src/agent/types.ts
interface AgentRunInput {
  // …现有字段不变
  system?: PromptBlock[];   // [s04] 控制器冻结的系统提示
  reminders?: string[];     // [s04] 本回合注入的提醒文本（已含标签）
}

// src/agent/context.ts
AgentContext.appendReminder(item: ModelReminderItem): void
```

## 模块设计

### prompt/builder.ts — 拼装核心

**职责：** 按优先级排序 Section、空行拼接、产出 `SystemPrompt{blocks, text}`。固定模块合成首个 `cacheable: true` 块，环境信息与其余可选模块各自成块且 `cacheable: false`。
**对外接口：** `buildSystemPrompt(env, optionalSections?)`、`PromptBlock`、`PromptSection`、`SystemPrompt`。
**依赖：** `sections.ts`（固定模块清单）、`environment.ts`（类型）。

### prompt/sections.ts — 七个固定模块正文

**职责：** 持有七个模块的中文正文常量与优先级，导出固定模块清单。内容要点：

1. **身份**：MyCode 是运行在 Windows 终端的 AI 编程助手，通过专用工具在用户工作区内读写执行；
2. **系统约束**：工作区边界不可越、严格 UTF-8、写入与命令必须经用户逐项批准、不执行破坏性操作、不泄露密钥；
3. **任务模式**：DO 模式直接执行；PLAN 模式只读探索并产出计划，模式以用户命令与系统提醒为准；
4. **动作执行**：先探索再行动、基于工具结果调整、验证先于结论、完成后再停；
5. **工具使用**：三条关键规则（优先专用工具而非 shell 命令、编辑前必须先读取、路径先查证）+ 六工具一句话职责索引；
6. **语气风格**：简洁、直接、中文交流、技术准确、不堆砌客套；
7. **文本输出**：Markdown 排版、代码块带语言标记、引用文件带相对路径、结论先行。

**依赖：** 无（纯常量）。

### prompt/environment.ts — 环境信息采集

**职责：** `collectEnvironment` 从 `process` 与 profile 采集六字段；渲染环境信息模块文本。
**依赖：** `config/types.ts`（ProviderProfile）。

### prompt/reminders.ts — 提醒生成

**职责：** 标签常量与 `wrapSystemReminder`；`PLAN_FULL_INTERVAL = 3`；Plan 完整指令文案（只读探索、不得修改、产出计划）与精简文案（一行）；`buildReminders(mode, turnIndex)`：`execute` → `[]`；`plan` 且 `(turnIndex - 1) % 3 === 0` → 完整；其余 → 精简。
**依赖：** `agent/types.ts`（AgentMode）。

### providers/anthropic.ts

- `system` 映射为块数组：`{type:'text', text, ...(cacheable ? {cache_control:{type:'ephemeral'}} : {})}`；
- 工具数组**末位**工具追加 `cache_control`（一个断点覆盖全部工具定义）；
- usage 解析增加 `cache_creation_input_tokens`、`cache_read_input_tokens`（`message_start` 携带）；
- items 转换链增加 `reminder` 显式分支 → `{role:'user', content: item.text}`。

### providers/openai-chat.ts

- blocks 拼接为首条 `{role:'system'}` 消息；
- items 转换链增加 `reminder` 分支 → `{role:'user'}` 消息。

### providers/openai-responses.ts

- blocks 拼接为 `instructions` 字段；
- items 转换链增加 `reminder` 分支 → `{role:'user'}` input 消息。

### agent/context.ts

- `appendReminder` 追加到 items 末尾。

### agent/runner.ts

- 回合上下文初始化后，把 `input.reminders` 逐条包装为 reminder 项追加；
- 每次迭代请求携带 `system: input.system`。

### agent/stream-collector.ts

- usage 聚合沿用现有 `||` 保留语义扩展到两个缓存字段（Anthropic 只在 `message_start` 上报，后续事件不覆盖）。

### chat/agent-controller.ts

- 新增私有字段保存冻结的系统提示；`initialize`、`createSession`、`switchSession` 时 `collectEnvironment` + `buildSystemPrompt` 重建；
- `#startRun` 内：`planTurnIndex = 当前模式为 plan 时，conversation.agentRuns 尾部连续 plan 模式 run 数 + 1`；`buildReminders(mode, planTurnIndex)` 随 run 输入传给 runner。

### tui/components/status-bar.tsx

- 用量区在 `tokens X↓ Y↑` 后追加 ` · cache N`（仅当缓存命中数大于 0 时显示）。

### tools/implementations/（六个文件）

- 仅改 `description` 文本：在功能说明后补充与该工具直接相关的规则（edit_file 含「编辑前必须先读取」、run_command 含「优先使用专用工具」、find_files/search_text 含「查证路径优先于猜测」等）；
- 旧描述按留痕规则保留在块注释；工具参数、能力与限制不变。

## 模块交互

**会话激活（构建并冻结）：**
```
initialize / createSession / switchSession
  → collectEnvironment(profile, cwd)
  → buildSystemPrompt(env)            → 存入 controller 私有字段
```

**回合发起（注入决策）：**
```
sendMessage → #startRun
  → getConversation(session)
  → planTurnIndex（尾部连续 plan run 数 + 1）
  → buildReminders(mode, planTurnIndex)
  → runner.run({…, system, reminders})
  → runner: context.appendReminder × N（位于最后一条用户消息之后）
```

**每次模型迭代（请求构造）：**
```
runner → streamChat({system, items[…含 reminder], tools})
  ├─ anthropic:   tools[末位+cache_control] + system[稳定块+cache_control, 环境块] + messages
  ├─ openai-chat: system 消息 + messages
  └─ responses:   instructions + input
```

**用量回流（缓存可观察）：**
```
anthropic message_start(含缓存字段) → collector usage_updated
  → runner 累计 totalUsage → projector → AppState.runUsage → 状态栏 cache N
```

## 文件组织

```
src/
├── prompt/                              [新建目录]
│   ├── builder.ts                       — PromptBlock/PromptSection/SystemPrompt、buildSystemPrompt
│   ├── sections.ts                      — 七个固定模块正文常量、优先级、固定模块清单
│   ├── environment.ts                   — EnvironmentInfo、collectEnvironment、环境模块渲染
│   └── reminders.ts                     — 标签常量、wrapSystemReminder、Plan 节奏与文案、buildReminders
├── providers/
│   ├── types.ts                         [改] Usage 缓存字段、ModelReminderItem、ChatRequest.system
│   ├── anthropic.ts                     [改] system 块数组、双 cache_control、缓存用量解析、reminder 分支
│   ├── openai-chat.ts                   [改] system 消息、reminder 分支
│   └── openai-responses.ts              [改] instructions 字段、reminder 分支
├── agent/
│   ├── types.ts                         [改] AgentRunInput 增加 system/reminders
│   ├── context.ts                       [改] appendReminder
│   ├── runner.ts                        [改] 接入 system 与 reminders
│   └── stream-collector.ts              [改] 聚合缓存用量字段
├── chat/
│   └── agent-controller.ts              [改] 会话激活时构建冻结系统提示；Plan 轮次推导与提醒生成
├── tui/components/
│   └── status-bar.tsx                   [改] 用量区追加缓存命中显示
└── tools/implementations/               [改×6] 六个工具描述双重强化

tests/
├── unit/prompt/                         [新建目录]
│   ├── builder.test.ts                  — 拼装顺序、空行分隔、可选模块扩展、确定性快照、长度上限
│   ├── sections.test.ts                 — 三规则齐备、环境字段渲染
│   ├── reminders.test.ts                — 标签包装、Plan 节奏序列、模式切换
│   └── environment.test.ts              — 六字段采集
├── unit/providers/
│   ├── anthropic.test.ts                [改] system 块数组、cache_control 位置、缓存字段解析、reminder 渲染
│   ├── openai-chat.test.ts              [改] system 首条消息、reminder 渲染
│   └── openai-responses.test.ts         [改] instructions、reminder 渲染
├── unit/agent/
│   └── runner.test.ts                   [改] system 透传、reminder 追加位置（context/collector 用例并入）
└── integration/
    └── plan-mode.test.ts                [改] 5 轮节奏序列、/do 停止注入、再入重置

tests/acceptance/                        [新建目录]
└── scenarios.md                         — F15 人工定性场景集（开发阶段产出）

spec_docs/s04/
├── spec.md                              [已生成]
├── plan.md                              — 本文档
├── task.md                              — 下一阶段生成
└── checklist.md                         — 阶段四生成

Project_Guide/s04.md                     — 状态导读（开发完成后按留痕规则撰写）
```

所有新代码注释以 `[s04]` 开头；被替换的 s01–s03 代码按留痕规则就近保留块注释并写明替换关系。

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 系统提示的传输结构 | `PromptBlock[]`（稳定块 + 环境块 + 可选块），而非单一字符串 | Anthropic 缓存断点需要落在「固定模块末尾、环境信息之前」；单一字符串无法表达断点位置，OpenAI 侧则直接拼接还原为单文本 |
| 缓存标记的归属层 | `cacheable` 标记放在 provider 中立的 `PromptBlock` 上，由各 provider 自行映射 | 上层不感知协议差异；Anthropic 映射为 `cache_control`，OpenAI 两协议忽略标记走自动缓存，符合 N2 |
| 工具定义的缓存方式 | 只在末位工具打 `cache_control` 断点 | Anthropic 断点语义是「缓存到此为止的全部前缀」，一个断点覆盖全部工具；全工具逐一打标无额外收益 |
| 提醒的载体 | 新增 `ModelReminderItem` 上下文项类型，而非拼进最后一条用户消息 | 类型安全，三个 provider 必须显式处理（消除 else 分支静默错转风险）；持久化层天然接触不到它，满足「不持久化」；标签文本由 prompt 模块生成，provider 保持无脑渲染 |
| Plan 轮次的来源 | 从 `conversation.agentRuns` 尾部连续 plan 模式 run 数推导 | `AgentRunRecord.mode` 已持久化且有序，推导即得；`/do` 产生的 execute run 天然打断连续序列，实现 F14「再入重置」；无需数据库迁移 |
| 缓存命中字段的持久化 | 不持久化，只走事件与界面即时展示 | spec F6 只要求可观察；SQLite 现有两列结构不动，免去一次迁移；重启后用量回显不含缓存字段属于可接受降级 |
| 系统提示的构建时机 | 会话激活时构建一次并冻结，存于控制器字段 | 满足 N3「会话内逐字节稳定」；日期等字段不在回合间漂移；每回合零重复构建成本 |
| 旧控制路径的处理 | chat/controller.ts、turn-orchestrator.ts 不接入系统提示 | 它们是 s01/s02 留痕保留路径，不在 s03 主流程上；改动它们只会扩大测试面，不改变任何现行行为 |
| 模块正文的存放 | 中文常量集中在 `sections.ts`，不开放配置 | 符合 spec「不开放给配置文件或模型修改」；单文件便于审阅总长度（N9）与后续章节替换为文件加载 |
