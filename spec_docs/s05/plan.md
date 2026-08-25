# MyCode 五层权限系统 Plan

## 架构概览

新增 `src/permissions/` 模块承载五层防御的全部判定逻辑，与既有 tools、agent、
chat、tui 四层的关系如下：

1. **权限引擎（PermissionEngine）**——核心新组件。对每次工具调用按固定顺序判定：
   黑名单（仅 run_command）→ 沙箱（仅文件类工具）→ 合并规则集 → 档位基线。
   输出三态决定：放行 / 询问 / 拒绝（携带来源与原因，回写模型）。
2. **黑名单（blacklist）**——内置正则集 + 类别标注，纯代码、纯函数，不可配置。
3. **规则存储（rule-store）**——负责三层 YAML 的路径、加载、Zod 校验、合并，
   以及永久规则与档位的本地级写入。读取在会话启动时一次完成。
4. **调度器改造（SafetyBatchScheduler）**——接入点。原有「副作用一律询问」
   改为「先经引擎判定」：放行的只读仍可并发；放行的副作用保留执行屏障但不再
   询问；询问的逐条进入人在回路；拒绝的直接产出 denied 工具结果。
5. **人在回路**——扩展现有 ApprovalCoordinator：审批决定从 批准/拒绝 两选
   扩展为 本次/本会话/永久/拒绝 四选；规则生成（精确匹配）由引擎完成，
   协调器只负责发布提示与回收决定。
6. **配置与界面**——`~/.mycode` 增加用户级规则文件；工作区 `.mycode/` 新增
   项目级与本地级规则文件；斜杠命令新增 /mode；状态栏显示当前档位；
   审批面板扩展为四选项。

关键边界：Plan 模式过滤（ToolPolicy）保持在管线之前不动；WorkspacePaths
保留在工具内部作为最终执行防线，同时向引擎暴露「包含性预检」能力，
使沙箱逃逸在执行前就成为带统一来源标注的拒绝。

## 核心数据结构

### PermissionMode

```ts
/** [s05] 三档权限模式：strict 全问、default 规则优先、allow 仅绝对层拦截。 */
export type PermissionMode = 'strict' | 'default' | 'allow';
```

### RuleOutcome 与 RuleSource

```ts
export type RuleOutcome = 'allow' | 'ask' | 'deny';
/** [s05] session 只存在于内存；其余三层对应 YAML 文件，层级不影响优先级。 */
export type RuleSource = 'user' | 'project' | 'local' | 'session';
```

### PermissionRule

```ts
export interface PermissionRule {
  tool: string;            // 六个实际工具名之一
  pattern: string;         // 命令文本或相对路径模式（精确或 glob）
  outcome: RuleOutcome;
  source: RuleSource;
  raw: string;             // 原始「工具名(模式)」文本，用于回显与拒绝原因
}
```

### PermissionDecision（判定三态）

```ts
export type PermissionLayer = 'blacklist' | 'sandbox' | 'rule' | 'mode' | 'human';
export type AskReason = 'strict_mode' | 'ask_rule' | 'unmatched';
export type PermissionDecision =
  | {kind: 'allow'}
  | {kind: 'ask'; reason: AskReason; rule?: PermissionRule}
  | {kind: 'deny'; layer: 'blacklist' | 'sandbox' | 'rule'; message: string; rule?: PermissionRule};
```

### AskChoice（人在回路四选）

```ts
/** [s05] once=本次放行；session/permanent 生成精确 allow 规则；denied 当次拒绝。 */
export type AskChoice = 'once' | 'session' | 'permanent' | 'denied';
```

既有 `ApprovalDecision = 'approved' | 'denied'` 保留不变（事件与存储继续用）；
协调器新增 `resolveAsk(callId, choice)`，三种放行选择在事件层统一映射为 approved。

### ToolTarget（规则与沙箱的匹配目标）

```ts
export type ToolTarget =
  | {kind: 'command'; value: string}                       // run_command 完整命令文本
  | {kind: 'path'; value: string; rawPath: string};        // 规范化相对路径 + 原始参数
```

由固定表从工具参数提取：run_command→command；read/write/edit_file→path；
find_files/search_text→path（缺省 '.'）。相对路径统一 `/` 分隔、去 `./` 前缀。

### 规则文件结构（Zod 校验）

```yaml
# 用户级 ~/.mycode/permissions.yaml 与项目级 <工作区>/.mycode/permissions.yaml
rules:
  allow: ["run_command(git *)", "read_file(src/**)"]
  ask:   ["run_command(npm test)"]
  deny:  ["read_file(**/.env)"]

# 本地级 <工作区>/.mycode/permissions.local.yaml 额外支持档位
mode: default            # strict | default | allow，缺失即 default
rules: { ... }           # 结构同上
```

`mode` 只允许出现在本地级文件；用户级/项目级出现即启动报错（N4 显错）。

### BlacklistEntry

```ts
export interface BlacklistEntry {category: string; pattern: RegExp}
/** 命中即返回类别；黑名单写在代码里，六个类别各配测试。 */
export function matchBlacklist(command: string): BlacklistEntry | null;
```

### PermissionEngine 对外接口

```ts
export class PermissionEngine {
  constructor(options: {rules: PermissionRule[]; mode: PermissionMode; workspace: WorkspacePaths});
  get mode(): PermissionMode;
  evaluate(call: ToolCall): Promise<PermissionDecision>;   // 五层顺序判定
  recordChoice(call: ToolCall, choice: AskChoice): Promise<void>; // 生成精确规则/写盘
  setMode(mode: PermissionMode): Promise<void>;            // 切换并持久化到本地级
}
```

### WorkspacePaths 新增

```ts
/** [s05] 仅验证包含性：语法检查 + 已存在部分 realpath，不要求目标存在。 */
assertContained(relativePath: string): Promise<void>;   // 逃逸抛 path_outside_workspace
```

## 模块设计

### permissions/blacklist.ts（新建）

**职责：** 内置危险命令正则集，命中即报类别。
**对外接口：** `matchBlacklist(command): BlacklistEntry | null`
**覆盖类别：** ①递归强制删除（rm -rf /、Remove-Item -Recurse -Force 根路径、rd /s /q 盘符）
②格式化与分区（Format-Volume、format、diskpart、Clear-Disk、bcdedit）
③关机重启（shutdown、Restart-Computer、Stop-Computer）
④注册表高危（reg add/delete HKLM、regedit /s、Set-ItemProperty HKLM:）
⑤禁用安全组件（Set-MpPreference 关实时防护、netsh advfirewall 全关、停 WinDefend 服务）
⑥下载执行（iwr|iex、curl|sh、Invoke-Expression 远程串、powershell -enc）
**依赖：** 无。

### permissions/glob.ts（新建）

**职责：** 把 glob 模式编译成正则；命令与路径两种语义。
**对外接口：** `matchGlob(pattern, value, kind: 'command' | 'path'): boolean`
**语义：** 命令：`*`=任意字符（含空格）、`?`=单字符；路径：`*`=不含 `/` 的任意字符、
`**`=含 `/` 的任意字符、`?`=单字符；两者均忽略大小写；其余字符按字面转义。
无 glob 元字符即精确匹配（忽略大小写）。
**依赖：** 无。

### permissions/rule.ts（新建）

**职责：** 解析规则字符串、按工具提取匹配目标、单条规则匹配。
**对外接口：**
`parseRuleSpec(raw: string): {tool, pattern} | null`（首个 `(` 与末个 `)` 切分，容许模式内含括号）
`extractTarget(call: ToolCall): ToolTarget | null`（固定工具表；缺参数返回 null）
`matchRule(rule, target): boolean`
**依赖：** glob.ts、tools/registry（工具名校验由 store 做）。

### permissions/rule-store.ts（新建）

**职责：** 三层文件的路径、加载、Zod 校验、合并；永久规则追加与档位读写。
**对外接口：**
`permissionPaths(home, workspace): {user, project, local}`
`loadRules(paths): {rules: PermissionRule[]; mode: PermissionMode}`
（缺文件=空集；解析失败抛 ConfigurationError 指明文件与问题；mode 只取自本地级）
`appendLocalRule(paths, rule: PermissionRule): void`（保留既有 YAML 内容的追加写）
`saveLocalMode(paths, mode): void`
**依赖：** yaml、zod、shared/errors。

### permissions/engine.ts（新建）

**职责：** 五层顺序判定；会话规则内存；人在回路选择后的规则生成；档位切换持久化。
**判定顺序（evaluate）：**
1. run_command 且黑名单命中 → deny（blacklist，含类别）
2. 文件类工具 → workspace.assertContained，逃逸 → deny（sandbox）
3. 合并规则集（三层 + 会话）匹配目标，命中中含 deny → deny（rule，含 raw）
4. 档位：strict → ask(strict_mode)；allow → allow
5. default：命中 allow → allow；命中 ask → ask(ask_rule)；
   未命中 → 只读 allow，写/命令 ask(unmatched)

**recordChoice：** session → 精确规则入内存（source=session）；
permanent → appendLocalRule 写盘后同条规则入内存（source=local），当前会话立即生效。
**依赖：** blacklist、glob、rule、rule-store、WorkspacePaths。

### tools/workspace-paths.ts（修改）

**职责：** 新增 `assertContained`：语法检查（拒绝对路径/盘符/`..` 逃逸）+
realpath 最近的已存在祖先做包含性判断；目标不存在不视为错误。
工具内部现有的 existingFile/newFile/searchRoot 全部保留，作为执行时最终防线。

### tools/approval-coordinator.ts（修改）

**职责：** `request(call, reason): Promise<AskChoice>`；提示增加询问原因展示。
`resolve` 拆为 `resolveAsk(callId, choice)`；interruptAll 仍按 denied 回收。

### agent/safety-batch-scheduler.ts（修改）

**职责：** 每个 available 调用先 `engine.evaluate`：

- allow + 只读 → 并入连续并发段
- allow + 写/命令 → 保留串行屏障，直接执行（不再询问）
- ask → 串行：发 approval_requested → 等 AskChoice → denied 出拒绝结果，
  放行类先 `engine.recordChoice` 再执行
- deny → 直接产出 `status:'denied'` 结果，error.details 含 layer/类别/规则原文

**依赖：** PermissionEngine（构造注入，替代原直接注入的 ApprovalCoordinator）。

### chat/commands.ts + agent-controller.ts + state.ts（修改）

**职责：** `parseChatCommand` 新增 `/mode`、`/mode strict|default|allow`
（无参时回显当前档位）；控制器处理命令、调用 engine.setMode、发布状态；
AppState 增加 `permissionMode`，随档位切换与启动加载更新。

### tui（修改）

- status-bar：档位与 PLAN/DO 并列展示（放行档用醒目颜色）
- tool-approval-panel：四选项 `Y 本次 / S 本会话 / P 永久 / N 拒绝`，展示询问原因
- chat-screen：审批中按键 y/s/p/n 映射到 resolveAsk

### cli/bootstrap.ts（修改）

**职责：** 启动时 `loadRules(permissionPaths(homedir(), process.cwd()))`；
解析失败即终止启动并报错（N4）；构造 PermissionEngine 注入控制器。

## 模块交互

### 启动

bootstrap → permissionPaths → loadRules（三层合并 + 本地级 mode）→
new PermissionEngine → ChatController（随 toolSystem 注入）→
SafetyBatchScheduler(executor, engine)；状态栏显示初始档位。

### 工具调用判定链（一次写/命令调用）

模型流 → ToolPolicy.prepare（Plan 过滤不变）→ scheduler：
engine.evaluate → 放行：直接 execute（屏障保留）；询问：事件 →
协调器发布提示 → TUI 四选 → resolveAsk → recordChoice（可写盘）→
execute 或产出拒绝；拒绝：直接产出 denied 结果。
所有结果经 tool_result 事件 → AgentContext 回写 → 下一轮模型可见，Loop 不终止。

### /mode 切换

输入 → parseChatCommand → controller.setPermissionMode →
engine.setMode（写本地级 YAML + 更新内存）→ 发布 AppState.permissionMode →
状态栏刷新；下一次 evaluate 立即使用新档位。

## 文件组织

```
src/
├── permissions/                      # [s05] 新增模块
│   ├── types.ts          — PermissionMode/Rule/Decision/AskChoice 等类型
│   ├── blacklist.ts      — 内置黑名单正则集与 matchBlacklist
│   ├── glob.ts           — 命令/路径两种语义的 glob 匹配
│   ├── rule.ts           — parseRuleSpec、extractTarget、matchRule
│   ├── rule-store.ts     — 三层路径、加载校验合并、本地级写入
│   └── engine.ts         — PermissionEngine 五层判定
├── tools/
│   ├── workspace-paths.ts    — 新增 assertContained（修改）
│   ├── approval-coordinator.ts — 四选审批（修改）
│   └── types.ts              — AskChoice、提示原因（修改）
├── agent/
│   └── safety-batch-scheduler.ts — 引擎判定接入（修改）
├── chat/
│   ├── commands.ts           — /mode 解析（修改）
│   ├── agent-controller.ts   — 档位命令处理与引擎注入（修改）
│   └── state.ts              — permissionMode 状态（修改）
├── tui/
│   ├── components/status-bar.tsx          — 档位展示（修改）
│   ├── components/tool-approval-panel.tsx — 四选面板（修改）
│   └── screens/chat-screen.tsx            — y/s/p/n 按键（修改）
└── cli/bootstrap.ts          — 启动加载规则与档位、显错（修改）

tests/
├── unit/permissions/         # 新增：glob、rule、rule-store、blacklist、engine
├── unit/tools/workspace-paths.test.ts  — assertContained 增补（修改）
├── unit/agent/               — scheduler 判定接入测试（修改）
├── integration/permissions.test.ts     — 新增：控制器+引擎+模拟模型流端到端
└── acceptance/scenarios.md   — 增补 s05 人工走查场景（修改）
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 判定归属 | 独立 permissions 模块，引擎注入调度器 | 五层顺序与优先级单点表达、可单测；scheduler 只做流程编排 |
| 沙箱双保险 | 引擎预检 assertContained + 工具内现有检查保留 | 预检产出统一拒绝来源；工具内检查防引擎被绕过的最后一道 |
| 规则文件格式 | 按结果分组的 YAML（allow/ask/deny 三列表） | 与「每条规则一个结果」模型直译；追加写永久规则实现简单 |
| mode 存放 | 只许本地级文件，其他层出现即报错 | 档位是个人本机信任状态，不该随项目共享或全局扩散；显错符合 N4 |
| 审批四选与存储 | 协调器返回 AskChoice，事件/存储仍映射 approved/denied | 不动 SQLite schema，无迁移；三种放行的区别只体现在规则生成 |
| 会话规则 | 引擎内存数组，与三层 YAML 同集合同优先级 | 满足 F12；会话结束自然消失，无清理负担 |
| glob 实现 | 自写迷你匹配器（*、**、?、忽略大小写） | 需求仅两个元字符量级，不引入新依赖；命令/路径两种语义一处表达 |
| 规则匹配目标 | 命令=完整文本 trim 后；路径=规范化相对路径 | 用户在 YAML 里写的就是这两个形态；realpath 只用于沙箱不用于匹配 |
| 黑名单范围 | 仅 run_command，六个类别各配代表性正则 | spec 边界；文件风险由沙箱兜底，保持黑名单职责单一 |
| /mode 命令 | 单命令带参数（/mode strict），无参回显 | 比三个独立命令少占命名空间；与 /plan /do 风格一致 |
| 放行档展示 | 状态栏常驻档位，放行档醒目颜色 | 档位持久化（含放行）的安全补偿：用户随时可见当前信任等级 |
| 拒绝原因格式 | error.details 带 layer/category/rule，message 中文可读 | 模型可读原因调整策略（F13）；界面可原文展示 |
