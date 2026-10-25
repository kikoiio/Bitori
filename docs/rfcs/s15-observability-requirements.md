# s15 需求文档：Bitori 可观察性系统

状态：已评审并实现（s15）；开放问题均按建议值定案，调试面板键位因 Ctrl+O 被占用改为 Ctrl+T
对应课程：`docs/learning/lessons/15.md`（待实现后撰写）
参考对象：dsh（DeepSeek Harness）、pi、opencode、Claude Code

## 1. 背景与动机

Bitori 当前具备完整的内存态事件流：`AgentRunner.run()` 产出 17 种 `AgentEvent`（run/iteration 生命周期、text/thinking delta、工具调用、审批、用量、进度），`chat/agent-event-projector.ts` 将其投影给 TUI；SQLite 持久化消息、工具批次与 AgentRun 记录。但观察止步于此，三个盲区导致 harness 问题只能盲调：

1. **请求不可见**：发给模型的完整请求（system、tool definitions、messages 数组）和模型返回的原始载荷（finishReason、providerState、错误响应体）没有持久化，也没有任何查看途径。调试 prompt、compaction、工具 description 的问题时无法回答"模型当时到底看到了什么"。
2. **过程不可回放**：模式切换、权限判定、审批决定、重试退避、压缩触发等过程事实只存在于内存或被投影丢弃；SQLite 只存最终消息形态，无法重建一次 run 的完整时序。
3. **没有日志层**：全仓库零处日志调用，无 Logger、无级别、无文件输出。异步故障（storage worker 异常、MCP 断连、hook 执行失败）发生时无任何痕迹。

## 2. 设计原则

1. **Model-visible means logged**（取自 dsh）：凡是发给模型的内容和模型返回的内容，必须可以从持久化日志完整重建。这是不可妥协的约束，其余一切为此让路。
2. **默认开启、零配置**：可观察性默认生效，不要求用户先配置才能在出事后回看。级别和输出位置可调，但不可关闭请求追踪（可以调保留期）。
3. **观察绝不干扰被观察者**：日志与追踪写入失败只降级不抛错；写入路径不得阻塞 agent loop（异步、有界队列）；TUI 正常渲染不受影响。
4. **本地优先、注意脱敏**：所有数据留在本机；API key、Authorization 头、`.env` 中的值在写入前脱敏。日志可能包含代码与工具输出，导出时明确提示。

## 3. 目标用户与场景

- **harness 开发者**（我们自己）：调试 agent loop、compaction、权限、重试逻辑；回答"这一轮模型收到了什么、返回了什么、为什么停"。
- **课程学习者**：lesson 15 的讲义与走查需要能"看见"loop 内部，这正是前 14 课一直缺的教学观测面。
- **benchmark 基建**：现有 `benchmarks/` 的自改进评测需要逐轮请求/结果数据作为输入，回放能力直接服务于此。

## 4. 功能需求

### FR1 结构化日志层

- 提供 `Logger`，级别 `debug | info | warn | error`，默认 `info`。
- 输出目标：`~/.bitori/logs/bitori.log`，按天滚动，保留最近 N 天（默认 7，可配）。
- 级别来源优先级：CLI `--log-level` > config `logging.level` > 默认值；`--log-file` 可覆盖输出路径。
- TUI 模式下任何日志不得写 stdout/stderr（会破坏 alt-screen 渲染）；文件是唯一输出，`--log-level debug` 时额外写 `<data-dir>/logs/debug.log`。
- 结构化字段：时间戳、级别、模块名（`agent`、`mcp`、`storage`、`hooks`、`tools`…）、消息、可选结构化上下文对象。
- 现有吞错点（storage worker 异常、hook 动作失败、MCP 传输错误）接入 warn/error 级日志。

### FR2 请求级追踪（trace，核心需求）

- 每次模型请求持久化一条 `request_start` 记录：完整 `requestItems`、system prompt 块、tool definitions、协议与模型名、`iterationId`/`iteration`、时间戳；一次 run 重建后必须能逐字节还原请求语义（允许 JSONL 序列化差异）。
- 每次响应持久化一条 `response` 记录：text、thinking、tool calls（含 argumentsText）、usage、finishReason、providerState、错误码与错误体、耗时。
- 重试可见：429/网络/5xx 的每次重试都记录（第几次、退避时长、失败原因）；压缩触发记录前后 token 数与保留边界；20 轮上限、未知工具上限触发记录为终态事实。
- 存储格式：每会话一个 JSONL 文件 `~/.bitori/traces/<sessionId>.jsonl`，追加写；会话恢复时续写同一文件。与 SQLite 分离，trace 不进数据库。
- 写入异步化：内存有界队列 + 后台 flush；队列满时丢弃并记 warn，绝不阻塞 loop。

### FR3 过程事件溯源

- 将 `AgentEvent`（含 `approval_requested/resolved` 的决定、`progress` 阶段迁移）以领域事件形式追加到 FR2 的同一 JSONL 流，事件类型明确枚举并带版本号 `v` 字段。
- 非事件的领域事实也入流：模式切换（plan/do）、会话创建/恢复、skill 热更新、MCP 连接/断开。
- 追踪文件即可独立回放一次 run 的完整时序，不依赖 SQLite。

### FR4 观察命令（CLI）

- `bitori sessions list`：列出会话（时间、profile、消息数、累计 token、状态）。
- `bitori sessions show <id>`：渲染一次会话的消息与工具调用摘要。
- `bitori trace show <sessionId> [--iteration N] [--json]`：渲染 trace：每轮的请求规模（条目数/估算 token）、响应、工具调用与结果、重试与耗时；`--iteration` 聚焦单轮；`--json` 供工具消费。
- `bitori trace tail [--session <id>]`：跟随模式，实时打印事件流（等价 dsh 的 session-follow）。

### FR5 TUI 调试视图

- 快捷键（建议 `Ctrl+O`，避免占用现有键位）切换调试面板：显示实时事件流、当前迭代/阶段、最近一次请求的规模与 preview（首尾各若干行）、累计与单轮用量。
- 状态栏常驻显示上下文占用（现有 footer 已有部分能力，统一数据源）。
- 面板数据来自内存事件流的第二个订阅者（projector 旁路），不读文件，不影响主渲染。

### FR6 导出与回放

- `bitori trace export <sessionId> [--out <file>]`：把 trace + 会话元数据打包为单个自包含 JSONL（默认脱敏），用于 bug 报告。
- `bitori trace replay <file>`：离线重放事件流，渲染时序摘要；为 benchmark 提供程序化入口（导出类型直接发布为内部 API）。

### FR7 权限与 Hook 协同

- 审批决定（谁、何时、approve/deny、档位）必须完整入 trace（FR3 已覆盖，此处为验收强调）。
- 可观察性自身不新增 Hook 事件（留待后续状态）；但 hook 执行结果（成功/失败/拦截）接入日志层。

### FR8 Token 用量与上下文组成分析

- **用量记录已具备**：`Usage`（input/output/cacheRead/cacheCreation）已按迭代与累计持久化到 SQLite 与 `usage_updated` 事件，本需求是把它**算清楚并显示出来**。
- **上下文组成分解**：每次请求把 `requestItems` 分解为固定桶并估算各桶 token——`system_prompt`（含 7 模块各自占比）、`tool_definitions`（含 MCP 工具占比）、`history_messages`、`tool_results`、`reminders`、`compact_summary`。每轮记录一条 `context_composition` 事件入 trace。
- **估算与校准**：桶内用统一估算器（字符/4 近似 + CJK 加权），并在事件中同时记录 provider 真实 input tokens，两者差值随事件保存——学习者能直接看到"估算 vs 真实"的偏差。
- **缓存视角**：Anthropic 的 cacheRead/cacheCreation 单独展示，能回答"这一轮有多少是缓存命中、断点是否生效"。
- **趋势**：`bitori trace show` 渲染逐轮组成堆叠摘要（文本表格即可，不强求图表）；`--json` 输出机器可读组成数据。
- **TUI**：调试面板（FR5）显示当前上下文组成占比与逐轮 token 曲线（ASCII 即可）。

### FR9 Skill 使用统计（参照 agent-skills/skill-tracker 模式）

- **记录时机**：`load_skill` 工具成功加载、ActiveSkills 环境注入、以及 slash command 触发 prompt 命令时各记一条使用记录。
- **记录格式**：对齐 skill-tracker 的 JSONL 模式——`{ts, sessionId, profile, kind: 'skill'|'command', name, source: 'model'|'auto'|'user', cwd}`，追加写 `~/.bitori/usage/skills.jsonl`（`skill-tracker` 用 O_APPEND 单行写入，本实现同样保证行完整性）。
- **trace 协同**：skill 加载同时作为领域事件入 FR3 的事件流，回放时可见"哪一轮、为什么激活了哪个技能"。
- **统计命令**：`bitori usage stats [--session <id>] [--kind skill|command] [--json]`：按名称聚合次数、最近使用时间、按会话分布；`bitori usage tail` 实时跟随。
- **显示**：TUI 调试面板显示本会话已激活技能与调用次数；`bitori sessions show` 附带该会话技能使用摘要。
- **隐私**：与 trace 同级脱敏；`usage/skills.jsonl` 只含名称与元数据，不含技能正文。

## 5. 非功能需求

- **性能**：trace 写入对每轮端到端耗时的额外开销 < 5ms（P95，队列未满时）；TUI 帧率无可感知变化。
- **故障隔离**：日志/trace 任何失败（磁盘满、路径不可写、worker 异常）只产生一条内部 warn 并降级，不得影响对话、工具执行或存储主链路。
- **脱敏**：`api_key`、`authorization`、`x-api-key`、`.env` 值在写入 trace 与日志前替换为 `<redacted>`；脱敏规则集中一处实现并有单测。
- **磁盘预算**：traces 与 logs 各有保留策略（默认保留 30 天 / 7 天，可配 `retention_days`），超期自动清理；`bitori trace show` 对大文件分页。
- **跨平台**：路径经 `configPaths()` 体系解析，Windows/macOS/Linux 行为一致。
- **测试**：Logger、脱敏、trace 写入/读取/导出/回放均有单测；token 估算器对中英文混合样本给出偏差上界（估算误差 ≤ 25%）；集成测试覆盖"一次含重试与审批的 run 产生完整可回放 trace"。

## 6. 验收标准

1. 任意一次真实对话结束后，`bitori trace show <sessionId>` 能展示每轮：请求条目数与 token、响应文本与工具调用、重试次数与耗时，且工具调用的 argumentsText 与实际执行一致。
2. 每轮可见上下文组成分解（七个桶），各桶之和与 provider 真实 input tokens 的偏差随轮可见；Anthropic 下缓存命中占比单独可见。
3. 触发过 `load_skill` 的会话中，`bitori usage stats` 能统计到对应技能的调用次数与来源；trace 回放能看到技能激活发生在哪一轮。
4. 人为制造 429（mock provider）后，trace 中可见完整重试序列与退避时长。
5. trace JSONL 中 grep 不到任何 `.env` 值或 API key（脱敏单测 + 导出文件人工抽查）。
6. 删除 traces 目录后再对话：功能正常，仅产生一条 warn 日志（故障隔离验证）。
7. `npm run check` 三平台通过；lesson 15 按课程格式完成，人工走查 checklist 记录在课内。

## 7. 里程碑（对应 lesson 15 的实现节拍）

| 节 | 内容 | 交付 |
|---|---|---|
| M1 | Logger + 脱敏 + 吞错点接入 | FR1、FR7 后半 |
| M2 | Trace JSONL 写入（请求/响应/重试/压缩/组成） | FR2、FR8 |
| M3 | 过程事件溯源（AgentEvent + skill/模式事实落流） | FR3、FR9 记录侧 |
| M4 | CLI 观察与统计命令 | FR4、FR6、FR9 查询侧 |
| M5 | TUI 调试视图（事件流 + 组成占比 + 用量） + 收尾走查 | FR5、lesson 15 撰写 |

## 8. 开放问题（评审时定）

1. **调试面板键位**：`Ctrl+O` 是否与现有键位冲突？（待实现时核对 keybindings 表）
2. **trace 粒度**：`text_delta`/`tool_arguments_delta` 这类流式碎事件是否逐条落流？建议：不逐条，`iteration_finished` 已含聚合结果，落流仅记聚合（体积与价值的平衡）。
3. **默认日志级别**：建议 `info`；`debug` 是否默认记录每个工具的完整结果文本（可能与工具结果落盘预算重复）？建议 debug 级才记。
4. **导出是否默认脱敏**：建议默认脱敏 + `--raw` 显式关闭，导出时打印提示。
5. **Skill 统计的联动范围**：`usage/skills.jsonl` 是 Bitori 专用格式，还是完全对齐 skill-tracker 的记录结构（`agent`/`parent`/`event_id` 字段）以便未来共用一个 dashboard？建议：字段超集对齐，Bitori 多出的字段（profile、sessionId）向后兼容。
6. **上下文组成的桶边界**：system prompt 七模块是否各自独立成桶（更细但事件更大）？建议：`system_prompt` 一个桶 + 七模块占比作为子字段，工具定义同理（内置 vs MCP 两个子字段）。
