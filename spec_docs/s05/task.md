# MyCode 五层权限系统 Tasks

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/permissions/types.ts` | PermissionMode/Rule/Decision/AskChoice/ToolTarget 等类型、PermissionGate 接口 |
| 新建 | `src/permissions/glob.ts` | 命令/路径两种语义的 glob 匹配 |
| 新建 | `src/permissions/blacklist.ts` | 内置黑名单正则集与 matchBlacklist |
| 新建 | `src/permissions/rule.ts` | parseRuleSpec、extractTarget、matchRule |
| 新建 | `src/permissions/rule-store.ts` | 三层路径、加载校验合并、本地级写入、createPermissionSystem |
| 新建 | `src/permissions/engine.ts` | PermissionEngine 五层判定 |
| 修改 | `src/tools/workspace-paths.ts` | 新增 assertContained 包含性预检 |
| 修改 | `src/tools/types.ts` | ToolApprovalPrompt 增加询问原因 |
| 修改 | `src/tools/approval-coordinator.ts` | 四选审批 resolveAsk |
| 修改 | `src/agent/safety-batch-scheduler.ts` | 引擎判定接入（executor, approvals, gate 三依赖） |
| 修改 | `src/chat/commands.ts` | /mode 命令解析 |
| 修改 | `src/chat/state.ts` | AppState.permissionMode |
| 修改 | `src/chat/agent-controller.ts` | 档位命令处理、引擎注入、resolveAskChoice |
| 修改 | `src/tui/components/status-bar.tsx` | 档位展示（放行档醒目） |
| 修改 | `src/tui/components/tool-approval-panel.tsx` | 四选面板与询问原因 |
| 修改 | `src/tui/screens/chat-screen.tsx` | y/s/p/n 按键映射 |
| 修改 | `src/cli/bootstrap.ts` | 启动加载规则与档位、显错、引擎注入 |
| 新建 | `tests/unit/permissions/glob.test.ts` | glob 两种语义与转义 |
| 新建 | `tests/unit/permissions/blacklist.test.ts` | 六类别命中与安全命令不误伤 |
| 新建 | `tests/unit/permissions/rule.test.ts` | 解析、目标提取、匹配 |
| 新建 | `tests/unit/permissions/rule-store.test.ts` | 三层合并、显错、追加写、档位读写 |
| 新建 | `tests/unit/permissions/engine.test.ts` | 判定顺序、三档语义、优先级、recordChoice |
| 修改 | `tests/unit/tools/workspace-paths.test.ts` | assertContained 增补 |
| 修改 | `tests/unit/tools/approval-coordinator.test.ts` | 四选 API 更新 |
| 修改 | `tests/unit/tools/batch-coordinator.test.ts` | 调度器引擎接入更新 |
| 修改 | `tests/unit/agent/runner.test.ts` | 调度器构造更新 |
| 修改 | `tests/unit/chat/commands.test.ts` | /mode 解析用例 |
| 新建 | `tests/integration/permissions.test.ts` | 模拟模型流端到端：拒绝不终止、三种放行、/mode |
| 修改 | `tests/integration/tool-turn.test.ts` 等既有集成测试 | 构造签名适配 |
| 修改 | `tests/tui/chat-screen.test.tsx`、`tool-components.test.tsx` | 四选面板与按键 |
| 修改 | `tests/acceptance/scenarios.md` | 增补 s05 人工走查场景 |
| 新建 | `Project_Guide/s05.md` | s05 状态导读 |
| 修改 | `AGENT.md` | 当前状态与阶段描述更新为 s05 |

## T1: permissions 类型定义与 glob 匹配器

**文件：** `src/permissions/types.ts`、`src/permissions/glob.ts`
**依赖：** 无

**步骤：**
1. `types.ts`：定义 `PermissionMode`、`RuleOutcome`、`RuleSource`、`PermissionRule`、
   `PermissionLayer`、`AskReason`、`PermissionDecision`、`AskChoice`、`ToolTarget`、
   `BlacklistEntry`，字段与 plan.md 一致；定义调度器依赖的结构接口
   `PermissionGate {evaluate(call): Promise<PermissionDecision>; recordChoice(call, choice): Promise<void>}`。
2. `glob.ts`：实现 `matchGlob(pattern, value, kind: 'command' | 'path'): boolean`——
   命令：`*`=任意字符（含空格）、`?`=单字符；路径：`*`=不含 `/`、`**`=含 `/`、`?`=单字符；
   均忽略大小写；正则元字符按字面转义；无元字符时退化为精确匹配（忽略大小写）。
3. 注释均以 `[s05]` 开头。

**验证：** `npm run typecheck` 通过。

## T2: glob 单元测试

**文件：** `tests/unit/permissions/glob.test.ts`
**依赖：** T1

**步骤：**
1. 精确匹配忽略大小写：`Git Status` 匹配 `git status`。
2. 命令语义：`git *` 匹配 `git commit -m "a b"`（`*` 跨空格）；`git ?` 不匹配 `git status`。
3. 路径语义：`src/*` 匹配 `src/a.ts` 不匹配 `src/x/a.ts`；`src/**` 匹配 `src/x/a.ts`；
   `**/.env` 匹配 `.env` 与 `config/.env`。
4. 字面转义：模式 `.env` 不匹配 `xenv`；`file?.ts` 的 `?` 按元字符处理。

**验证：** `npx vitest run tests/unit/permissions/glob.test.ts` 通过。

## T3: 黑名单

**文件：** `src/permissions/blacklist.ts`
**依赖：** 无

**步骤：**
1. 按 plan.md 六个类别各写代表性正则：递归强制删除（`rm -rf /`、
   `Remove-Item` 带 `-Recurse` 与 `-Force` 指向根/盘符、`rd /s /q` 盘符）、
   格式化与分区（`Format-Volume`、`format.com`、`diskpart`、`Clear-Disk`、`bcdedit`）、
   关机重启（`shutdown`、`Restart-Computer`、`Stop-Computer`）、
   注册表高危（`reg add/delete` HKLM、`regedit /s`、`Set-ItemProperty HKLM:`）、
   禁用安全组件（`Set-MpPreference -DisableRealtimeMonitoring`、
   `netsh advfirewall set allprofiles state off`、`Stop-Service WinDefend`）、
   下载执行（`iwr … | iex`、`curl … | sh`、`powershell -enc`）。
2. 实现 `matchBlacklist(command): BlacklistEntry | null`，按数组顺序返回首个命中。
3. 每条正则附 `[s05]` 注释说明防御目标。

**验证：** `npm run typecheck` 通过。

## T4: 黑名单单元测试

**文件：** `tests/unit/permissions/blacklist.test.ts`
**依赖：** T3

**步骤：**
1. 六个类别各取 2–3 条代表命令断言命中且类别正确（含大小写变体、参数顺序变体）。
2. 安全命令断言不命中：`git status`、`npm test`、`Remove-Item foo.txt`、
   `Get-ChildItem C:\`、`Invoke-Expression "Get-Date"`。
3. 误伤边界：`Remove-Item -Recurse -Force ./build`（工作区内相对路径）不命中。

**验证：** `npx vitest run tests/unit/permissions/blacklist.test.ts` 通过。

## T5: 规则解析与匹配

**文件：** `src/permissions/rule.ts`
**依赖：** T1

**步骤：**
1. `parseRuleSpec(raw): {tool, pattern} | null`——首个 `(` 与末个 `)` 切分，
   工具名 trim、pattern 保留原始内部文本（trim 两端）；形状非法返回 null。
2. `extractTarget(call, workspaceRoot): ToolTarget | null`——固定表：
   run_command→`{kind:'command', value: command.trim()}`；
   read/write/edit_file→path；find_files/search_text→path 缺省 `'.'`；
   路径经 `resolve`+`relative` 规范化、`sep` 换 `/`、去 `./` 前缀；
   未知工具或缺参数返回 null。
3. `matchRule(rule, target): boolean`——工具名相等且按 target.kind 调 matchGlob。
4. 注释以 `[s05]` 开头。

**验证：** `npm run typecheck` 通过。

## T6: 规则解析与匹配单元测试

**文件：** `tests/unit/permissions/rule.test.ts`
**依赖：** T5

**步骤：**
1. 解析：常规规则、模式内含括号（`run_command(echo (ok))`）、含空格模式均正确切分；
   无括号/空模式/空工具名返回 null。
2. 目标提取：六类工具各一例；find_files 缺省 path 得 `.`；
   Windows 反斜杠与 `./` 前缀归一化。
3. 匹配：工具名不同不匹配；command 目标不匹配 path 规则；glob 与精确各一例。

**验证：** `npx vitest run tests/unit/permissions/rule.test.ts` 通过。

## T7: WorkspacePaths.assertContained 与测试

**文件：** `src/tools/workspace-paths.ts`、`tests/unit/tools/workspace-paths.test.ts`
**依赖：** 无

**步骤：**
1. 新增 `assertContained(relativePath): Promise<void>`：复用 `#syntactic` 做语法检查；
   从候选路径向上找最近已存在祖先并 realpath，逃逸抛
   `WorkspacePathError('path_outside_workspace', …)`；目标不存在不报错。
2. 既有 existingFile/newFile/searchRoot 保持不变；新注释以 `[s05]` 开头。
3. 测试增补：符号链接指向工作区外被拒；不存在的深层内部路径通过；
   绝对路径与 `..` 被拒；既有用例全部保持通过。

**验证：** `npx vitest run tests/unit/tools/workspace-paths.test.ts` 通过。

## T8: 规则存储

**文件：** `src/permissions/rule-store.ts`
**依赖：** T5（parseRuleSpec）

**步骤：**
1. `permissionPaths(home, workspace)`：user=`~/.mycode/permissions.yaml`、
   project=`<workspace>/.mycode/permissions.yaml`、
   local=`<workspace>/.mycode/permissions.local.yaml`。
2. Zod schema：rulesSchema（allow/ask/deny 可选字符串数组）；用户/项目级
   对 `mode` 键显错（refine 报「mode 只允许出现在本地级文件」）；
   本地级额外允许 `mode: enum`。
3. `loadRules(paths)`：缺文件=空集；逐文件 YAML 解析 + schema 校验 +
   逐条 parseRuleSpec 与工具名（六工具之一）校验，失败抛
   `ConfigurationError` 并指明文件与问题；合并时标注 source；mode 取自本地级缺省 default。
4. `appendLocalRule(paths, rule)`：读取本地级文件（缺失则建），向 `rules.allow`
   追加 `rule.raw`，yaml 回写，保留既有内容（含 mode），自动创建 `.mycode` 目录。
5. `saveLocalMode(paths, mode)`：读改写 `mode` 键，保留 rules。
6. `createPermissionSystem(home, workspaceRoot)`：loadRules + WorkspacePaths.create +
   构造 PermissionEngine，供 bootstrap 一步调用。
7. 注释以 `[s05]` 开头。

**验证：** `npm run typecheck` 通过。

## T9: 规则存储单元测试

**文件：** `tests/unit/permissions/rule-store.test.ts`
**依赖：** T8

**步骤：**
1. 用临时目录构造三层文件：合并后规则条数与 source 标注正确。
2. 全部缺失 → 空规则集 + mode default。
3. 用户级文件含 `mode` → ConfigurationError 且消息含文件路径。
4. 未知工具名、非法规则字符串、YAML 语法错误各一例 → 均显错指明文件。
5. `appendLocalRule`：向无文件/已有内容（含 mode 与其他规则）两种情形追加，
   重读后新规则存在且旧内容保留。
6. `saveLocalMode` 往返：写入后 loadRules 读到新档位，rules 不变。

**验证：** `npx vitest run tests/unit/permissions/rule-store.test.ts` 通过。

## T10: 权限引擎

**文件：** `src/permissions/engine.ts`
**依赖：** T1、T3、T5、T7、T8

**步骤：**
1. `PermissionEngine implements PermissionGate`：构造接收
   `{rules, mode, workspace?, paths?}`；workspace/paths 缺省时跳过沙箱层、
   permanent 降级为 session（供无磁盘测试环境）。
2. `evaluate(call)` 按 plan 五层顺序：黑名单 → assertContained（文件类）→
   合并规则（deny 优先短路）→ 档位（strict→ask(strict_mode)；allow→allow）→
   default 分支（allow 规则→allow；ask 规则→ask(ask_rule)；未命中只读 allow、
   写/命令 ask(unmatched)）；deny 消息中文可读并带 layer/category/rule.raw。
3. `recordChoice(call, choice)`：session → 精确规则入内存（source=session）；
   permanent → appendLocalRule 写盘后入内存（source=local）；
   精确规则 raw 为 `工具名(精确目标)`，目标取 extractTarget 的 value。
4. `setMode(mode)`：有 paths 时 saveLocalMode 持久化；更新内存档位；`get mode`。
5. 会话规则与三层规则同一数组参与匹配（deny>ask>allow 自然生效）。
6. 注释以 `[s05]` 开头。

**验证：** `npm run typecheck` 通过。

## T11: 引擎单元测试

**文件：** `tests/unit/permissions/engine.test.ts`
**依赖：** T10

**步骤：**
1. 顺序：黑名单命中在放行档 + allow 规则下仍 deny（layer=blacklist）；
   沙箱逃逸在 allow 规则下仍 deny（layer=sandbox，临时目录造符号链接）。
2. 优先级：同一调用三层分别命中 allow/ask/deny → deny；只 allow+ask → ask；
   调换层级结果不变。
3. 三档矩阵：strict 下只读 ask、allow 规则失效、deny 仍拒；
   default 下只读未命中 allow、写/命令未命中 ask、规则按结果执行；
   allow 档下写/命令 allow、deny 规则仍拒。
4. recordChoice：session 后同调用 evaluate→allow 且重启（新引擎）失效；
   permanent 写盘后新引擎加载生效（临时目录）。
5. 只读可控：`deny read_file(**/.env)` 命中读取 .env → deny(layer=rule)。

**验证：** `npx vitest run tests/unit/permissions/engine.test.ts` 通过。

## T12: 四选审批：类型与协调器

**文件：** `src/tools/types.ts`、`src/tools/approval-coordinator.ts`、`tests/unit/tools/approval-coordinator.test.ts`
**依赖：** T1

**步骤：**
1. `ToolApprovalPrompt` 增加 `askReason?: string`（中文询问原因，界面展示用）。
2. 协调器 `request(call, askReason?)` 返回 `Promise<AskChoice>`；
   `resolveAsk(callId, choice)` 取代原 `resolve`；`interruptAll` 按 denied 回收；
   旧 `resolve` 实现按留痕规则块注释保留。
3. 测试更新：四选各路径、interruptAll 回收为 denied、只读仍直接 once
   （沿用 read 短路，返回 'once'）。
4. 注释以 `[s05]` 开头。

**验证：** `npx vitest run tests/unit/tools/approval-coordinator.test.ts` 通过。

## T13: 调度器引擎接入

**文件：** `src/agent/safety-batch-scheduler.ts`
**依赖：** T10、T12

**步骤：**
1. 构造函数改为 `(executor, approvals, gate: PermissionGate)`。
2. 每个 available 调用先 `gate.evaluate`：
   allow 只读→连续并发段；allow 写/命令→串行屏障直接执行（不再发审批事件）；
   ask→串行：approval_requested（prompt 带 askReason）→ 等 AskChoice →
   denied 出 `status:'denied'`（details.layer='human'），放行类先
   `gate.recordChoice` 再执行；deny→直接产出 denied 结果（details 含层信息）。
3. approval_resolved 事件的 decision：once/session/permanent 映射 'approved'，
   denied 映射 'denied'（存储不变）。
4. 旧的「副作用一律审批」实现按留痕规则块注释保留；新注释 `[s05]`。
5. 进度事件与中断语义保持不变。

**验证：** `npm run typecheck` 通过。

## T14: 调度器与 runner 测试更新

**文件：** `tests/unit/tools/batch-coordinator.test.ts`、`tests/unit/agent/runner.test.ts`
**依赖：** T13

**步骤：**
1. 构造更新：三依赖注入；gate 用真实 PermissionEngine（空规则、临时 workspace）
   或最小 mock。
2. 新增用例：allow 规则下写文件不询问直接执行；deny 规则下产出 denied 结果且
   不进入执行器；ask 路径选 session 后 recordChoice 被调用。
3. 既有 runner 用例适配新构造后全部通过。

**验证：** `npx vitest run tests/unit/agent tests/unit/tools/batch-coordinator.test.ts` 通过。

## T15: /mode 命令与控制器状态

**文件：** `src/chat/commands.ts`、`src/chat/state.ts`、`src/chat/agent-controller.ts`、`tests/unit/chat/commands.test.ts`
**依赖：** T10

**步骤：**
1. `parseChatCommand`：`/mode` → `{type:'mode', mode:null}`；
   `/mode strict|default|allow` → `{type:'mode', mode}`；原 'plan'/'do' 不变；
   ChatCommand 类型同步扩展。
2. `AppState` 增加 `permissionMode: PermissionMode`，初始 'default'。
3. 控制器：`ControllerToolSystem` 增加可选 `permissions?: PermissionEngine`；
   缺省时用无沙箱无持久化的空引擎；`initialize` 时把引擎档位写入状态。
4. `sendMessage` 处理 mode 命令：有参→`setPermissionMode`（engine.setMode +
   发布状态）；无参→visibleError 回显当前档位。
5. `resolveToolApproval(decision)` 改为 `resolveAskChoice(choice: AskChoice)`，
   供 TUI 调用；旧实现留痕块注释。
6. commands 测试增补 /mode 各形态与非法参数。

**验证：** `npx vitest run tests/unit/chat tests/integration/chat-controller.test.ts` 通过。

## T16: TUI 三处改造

**文件：** `src/tui/components/status-bar.tsx`、`src/tui/components/tool-approval-panel.tsx`、`src/tui/screens/chat-screen.tsx`、`tests/tui/chat-screen.test.tsx`、`tests/tui/tool-components.test.tsx`
**依赖：** T12、T15

**步骤：**
1. 状态栏：PLAN/DO 后追加档位（严格/默认/放行中文标签），放行档用醒目颜色。
2. 审批面板：四选项文案 `Y 本次 / S 本会话 / P 永久 / N 拒绝 / Ctrl+C 取消`；
   有 askReason 时展示。
3. chat-screen：审批中 y→once、s→session、p→permanent、n→denied，
   调 `resolveAskChoice`；其余按键逻辑不变。
4. TUI 测试：面板四选项可见；按键映射正确；状态栏档位显示（含放行档颜色）。
5. 注释以 `[s05]` 开头。

**验证：** `npx vitest run tests/tui` 通过。

## T17: bootstrap 接线

**文件：** `src/cli/bootstrap.ts`
**依赖：** T10、T15

**步骤：**
1. 启动时 `await createPermissionSystem(homedir(), process.cwd())`，
   ConfigurationError 原样上抛（启动终止并显示错误，符合 N4）。
2. 引擎随 toolSystem 注入 ChatController（`permissions` 字段）。
3. 留痕块注释 + `[s05]` 新注释。

**验证：** `npm run typecheck` 通过；`npm run build` 通过。

## T18: 集成测试（端到端判定链）

**文件：** `tests/integration/permissions.test.ts`、既有集成测试适配
**依赖：** T13、T15、T16、T17

**步骤：**
1. 临时 home + workspace 启动控制器（mock LLM client），覆盖：
   黑名单命令 → denied 结果回写、Loop 继续至自然完成（AC12 前半）；
   ask 选 denied → Loop 继续（AC12 后半）；
   allow 规则命中 → 不询问直接执行；
   ask 选 session → 同会话第二次不再询问；
   ask 选 permanent → 本地级文件出现精确规则；
   `/mode allow` 后写文件不询问、`/mode` 回显档位。
2. 既有集成测试（tool-turn、tool-persistence、agent-cancellation、plan-mode）
   按新构造/新审批流适配，行为预期不变的全部保持。
3. 全部用真实临时目录与 mock 模型流，不依赖网络。

**验证：** `npx vitest run tests/integration` 通过。

## T19: 人工走查场景增补

**文件：** `tests/acceptance/scenarios.md`
**依赖：** 无

**步骤：**
1. 追加 s05 场景节：AC14 完整走查（allow git 规则 + 默认档：git status 免问、
   npm test 问一次选本会话后免问、切放行档写文件免问、黑名单命令仍拒、
   重启后本会话规则失效恢复询问）。
2. 每场景写明：目的、前置条件（规则文件内容）、操作步骤、观察点。

**验证：** 文档存在，s05 场景齐备且含前置条件与观察点。

## T20: 全量检查与修复

**文件：** 全项目
**依赖：** T1–T19

**步骤：**
1. 运行 `npm run check`（typecheck + lint + 全部测试 + 构建）。
2. 修复任何失败项并复跑，直到全绿。

**验证：** `npm run check` 全部通过。

## T21: 状态留痕文档

**文件：** `Project_Guide/s05.md`、`AGENT.md`
**依赖：** T20

**步骤：**
1. 按既有导读格式撰写 `Project_Guide/s05.md`：五层防御结构、规则格式与三层文件、
   三档语义、人在回路四选、文件变化清单、验证结论。
2. `AGENT.md`：当前状态标记更新为 `s05`，「当前阶段」追加 s05 要点；
   不改动 s01–s04 历史描述。

**验证：** 两份文档存在且内容对应；`AGENT.md` 当前状态为 `s05`。

## 执行顺序

```
T1 ──→ T2                （glob 测试）
T3 ──→ T4                （黑名单，独立）
T5 ──→ T6                （规则解析）
T7                       （沙箱预检，独立）
T5,T1 ──→ T8 ──→ T9      （规则存储）
T1,T3,T5,T7,T8 ──→ T10 ──→ T11   （引擎）
T1 ──→ T12               （四选协调器）
T10,T12 ──→ T13 ──→ T14  （调度器接入）
T10 ──→ T15              （/mode 与控制器）
T12,T15 ──→ T16          （TUI）
T10,T15 ──→ T17          （bootstrap）
T13,T15,T16,T17 ──→ T18  （集成测试）
T19 全程独立，可随时插入

全部完成 ──→ T20 ──→ T21
```
