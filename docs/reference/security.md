# 安全模型与审计记录

> 审计日期：2026-11-01。本文是「模型可以驱动本地工具」前提下的信任边界记录：威胁、控制、验证证据与**已知残留风险**。

## 威胁模型

| # | 威胁 | 入口 | 关键假设 |
|---|------|------|----------|
| T1 | Prompt injection 诱导执行高危操作 | 仓库文件内容、`read_file`/`run_command` 输出、MCP 返回、网页文本 | 注入文本会进入模型上下文，模型可能被指令劫持 |
| T2 | 审批绕过 | 多工具并发轮次、会话/永久白名单复用、参数篡改 | 审批只覆盖了“某一次”调用 |
| T3 | Shell 与路径穿越 | `run_command` 参数、`edit_file`/`write_file` 路径、符号链接 | 模型给出工作区外路径或逃逸进程树 |
| T4 | 密钥泄漏 | 错误信息、日志、trace 导出、artifact、UI 快照、桌面渲染进程 | Provider 回显请求头，或密钥进入历史会话 |
| T5 | 外链协议滥用 | Markdown 渲染的链接、`window.open`、导航 | `javascript:`/`file:` 之类伪协议被执行 |
| T6 | 工作区自带扩展的启动信任 | 项目级 `.bitori/config.yaml`（MCP）与 `hooks.yaml` | clone 一个仓库即在其目录拉起进程 |

## 控制与验证证据

### T1 注入 → 高危工具
- 默认权限档下所有 `effect: 'write' | 'command'` 的工具调用都必须逐次审批，读取类工具自动放行；审批面板展示**真实的命令/路径/diff**，用户看到的即将被执行的。
- 注入文本无论出现在文件、工具结果还是模型输出中，都只影响模型提议，不能直接触发执行——执行入口只有 Agent 循环 → `SafetyBatchScheduler` → 审批。
- 验证：`tests/integration/security-boundaries.test.ts`（读取含「跳过审批」指令的文件后仍必须审批，拒绝后命令未执行）。

### T2 审批绑定
- 审批决定与具体 `callId` 绑定：同轮两个写入只放行被批准的一个（测试覆盖）。
- `approved_once` 不复用；`approved_session` 仅会话内；`approved_permanent` 写入 `.bitori/permissions.local.yaml` 的**精确匹配**规则（`tests/unit/tools/permission-engine.test.ts`）。
- 取消/拒绝在审批发布瞬间被竞态处理不丢失决定（`tests/unit/agent/runner.test.ts`）。

### T3 Shell 与路径
- `WorkspacePaths` 以 `realpath` 归一并校验，父目录与符号链接均不可逃逸工作区（`src/tools/workspace-paths.ts`）。
- `write_file` 排他创建、`edit_file` 唯一字面匹配失败即拒绝执行；提交均走临时文件 + 原子 rename，取消不留半写入（工具单测覆盖提交点前后的中断）。
- `run_command` 超时与进程树清理由 `OwnedProcessTree` 保证（`shared/owned-process-tree.ts`）。
- 撤销同样验证内容哈希：当前内容与 Bitori 写入结果不一致（被外部修改）时**拒绝盲目覆盖**（`tests/unit/tools/snapshots.test.ts`）。

### T4 密钥脱敏
- 单一出口 `redactSecrets`/全局 redactor：日志文件（`shared/logger.ts`）、trace 导出（`trace/export.ts` 默认脱敏，`--raw` 才关闭）、Provider 错误归一化（`providers/errors.ts`）。
- UI/快照边界只携带 `ProfileSummary`（name/protocol/model），`main.cjs` 的 IPC 输入统一 `checkedText` 校验，桌面渲染进程永远拿不到 apiKey 值。
- `bitori doctor` 与连接探测只输出来源变量名与布尔状态；错误文本再经脱敏。
- 验证：`tests/unit/config/secrets.test.ts`、`tests/unit/providers/errors.test.ts`、`tests/unit/diagnostics/connection.test.ts`（探测输出不含密钥）、`tests/unit/cli/doctor.test.ts`（诊断 JSON 不含密钥）。

### T5 外链协议
- Markdown 链接白名单 http/https/mailto，其余降级为文本；`img-src 'none'`；`setWindowOpenHandler` deny + `will-navigate` preventDefault（`tests/desktop/smoke.mjs` 断言 `<img>` 渲染数为 0）。

### T6 工作区信任（本次新增）
- 信任清单：`~/.bitori/trusted-workspaces.json`，`bitori trust [path] [--revoke]` 管理（`src/config/trust.ts`）。
- 桌面端“信任并打开”对话框确认后**持久化**到清单（`main.cjs`）。
- `bitori doctor` 输出「工作区信任」检查：项目级 MCP/Hooks 存在且未信任 → `warn` 并给出处置命令。
- **默认拒载（2026-11-01 强制化）**：未信任工作区的 `loadConfig` 跳过项目级 `.bitori/config.yaml` 的 MCP 配置，`createAgentServices` 不加载项目级 `hooks.yaml`，并在 `AppConfig.notices`/运行时 warnings 中呈现原因；`bitori trust` 或桌面确认后才启用。验证：`tests/integration/workspace-trust.test.ts`、`tests/unit/config/loader.test.ts`、`tests/unit/config/trust.test.ts`。

## 已知残留风险（不得视为默认安全）

1. ~~TUI 未强制拦截未信任工作区的项目扩展加载~~ → **已强制**：未信任工作区的项目级 MCP/Hooks 默认拒载（见上）。残留：`BITORI.md/AGENTS.md` 指令、skills、命令、agents 仍按现有文档加载策略读入——它们不能执行进程，但内容会进入模型上下文；克隆仓库前仍应自行审查。
2. 模型可诱导用户**批准**恶意指令（审批文案即真实参数是最后防线，人仍是决策点）。
3. `bitori trust` 是本地文件，无密码学保护；工作区路径移动后需重新 trust。
4. bypass 档跳过逐次审批（UI 有持续横幅提示，见 `security-boundaries` 测试），仅应在受信环境使用。
5. trace/历史消息保存模型输出的原文；若模型复述了它读到的机密，脱敏字典（仅 `.env`/配置内值）无法覆盖未知机密——导出共享前仍需人工检查。

## 修复记录

- 2026-11-01：审批四选项桌面统一、`/undo` 快照撤销、放行档持久提示、信任清单 + `bitori trust` + doctor 检查、探测/诊断输出脱敏测试补齐。
