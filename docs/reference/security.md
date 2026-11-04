# 安全模型与审计记录

> 审计日期：2026-11-03。本文记录 Bitori 的信任边界、具体控制、验证证据与仍无法消除的风险。模型可以提出本地工具调用；文件权限和审批仍是关键保护边界。

## 威胁模型

| # | 威胁 | 入口 | 关键假设 |
|---|------|------|----------|
| T1 | Prompt injection 诱导执行高危操作 | 项目文件、`read_file`/`run_command` 输出、MCP 返回、网页文本 | 注入文本会进入模型上下文，模型可能被指令劫持 |
| T2 | 审批诱导或范围误判 | 工具名称、参数、命令与写入内容 | 用户可能未看清实际目标或副作用 |
| T3 | Shell 与路径穿越 | `run_command` 参数、文件工具路径、符号链接 | 模型可能给出工作区外路径或逃逸进程树 |
| T4 | 密钥或会话机密泄漏 | 错误信息、日志、trace 导出、会话归档、UI 快照 | Provider 回显请求头，或模型复述读到的秘密 |
| T5 | 外链协议滥用 | Markdown 链接、`window.open`、导航 | `javascript:`/`file:` 等伪协议可能被执行 |
| T6 | 项目内容未经审查即影响模型或运行时 | 项目指令、skills、命令、agents、权限、MCP/Hooks | clone 仓库后自动加载内容或启动进程 |

## 控制与验证证据

### T1/T6 项目信任与注入

- 工作区只有在用户执行 `bitori trust` 或确认桌面“信任并打开”后，才会加载项目级 MCP/Hooks、提示、记忆、skills、commands、agents、权限规则及 `permissions.local.yaml`。未信任时这些项目内容默认拒载；用户级配置仍可用。`bitori doctor` 与 `bitori trust --json` 会把项目记忆目录计入项目内容提示。
- 组装提示时会说明项目文件、工具输出、MCP 内容及扩展文本是数据，不能覆盖安全要求或审批边界。该提示能降低注入影响，不能保证模型始终遵守。
- 验证：`tests/integration/workspace-trust.test.ts`、`tests/integration/security-boundaries.test.ts`、`tests/unit/config/trust.test.ts`、skills/commands/agents/permissions/instructions 的定向单测。

### T2 审批与权限

- 默认档下写入和命令需逐次审批。审批请求携带精确工具参数，并提示检查命令与参数、目标路径和完整内容或 diff。审批决定绑定具体调用；会话批准按会话 ID 隔离，永久批准写入精确参数规则。
- `/permission bypass` 只提出启用请求；须在 60 秒内、同一聊天中再次输入 `/permission bypass confirm`。切换聊天时立即清除该聊天的 bypass；旧文件中的持久化 `bypass` 会降为 `default`。当前聊天 bypass 仍会跳过逐项审批，用户应在可信环境临时使用。
- 验证：`tests/integration/security-boundaries.test.ts`、`tests/unit/tools/permission-engine.test.ts`、`tests/unit/tools/approval-coordinator.test.ts`。

### T3 Shell 与路径

- `WorkspacePaths` 以 `realpath` 归一并校验；文件工具拒绝越出工作区的路径。危险命令黑名单在权限档位之前判定。
- `write_file` 排他创建、`edit_file` 唯一字面匹配失败即拒绝；提交使用临时文件和原子 rename。`run_command` 的超时与进程树清理由 `OwnedProcessTree` 管理。
- 撤销操作验证当前内容与 Bitori 写入结果一致；外部修改后拒绝覆盖。
- 验证：`tests/unit/tools/` 与 `tests/integration/security-boundaries.test.ts`。

### T4 密钥与导出

- 日志与 trace 默认使用 `redactSecrets`；trace 的 `--raw` 会关闭脱敏。Provider 错误归一化也会脱敏。UI/桌面 renderer 只拿到 `ProfileSummary`，不持有 API key。
- 新建或复用的 trace 导出文件在 POSIX 系统设为 `0600`；会话归档临时文件也设为 `0600`。这限制其他本机账户读取，不防御当前登录账户。
- 导出会话不包含配置或凭据字段，但消息、工具参数/输出和图片可能含项目秘密。未知秘密无法可靠自动识别；分享前应检查内容。`--raw` 仅用于用户明确需要保留原始 trace 的场景。
- 验证：`tests/unit/trace/export.test.ts`、`tests/unit/storage/archive.test.ts`、`tests/unit/config/secrets.test.ts`、`tests/unit/providers/errors.test.ts`、`tests/unit/diagnostics/connection.test.ts`、`tests/unit/cli/doctor.test.ts`。

### T5 外链协议

- Markdown 链接只允许 `http`、`https`、`mailto`；其他协议显示为文本。CSP 禁止远程图片，Electron 拒绝新窗口与页面导航。
- 验证：`tests/desktop/smoke.mjs`（远程图片不渲染、导航策略）。

### T6 信任清单存储

- `~/.bitori/trusted-workspaces.json` 必须是当前用户拥有、POSIX 权限不向组或其他用户开放的普通文件；读取拒绝符号链接和损坏内容。写入使用同目录私有临时文件与原子替换，进程内对 read-modify-write 排队。
- 权限清单的原子发布、模式、符号链接和损坏输入由 `tests/unit/config/trust.test.ts` 覆盖。更改安全处理后还需在提交上完成 GitHub Actions Check。

## 剩余风险

1. 已信任的仓库仍可通过指令、skills、命令、agents、MCP/Hooks 或工具输出影响模型。系统提示将其标为不可信数据并不构成沙箱；信任前应审查来源与内容。
2. 模型可能诱导用户批准恶意调用或用户可能误读审批内容。界面展示实际参数和风险提示，但最终决定仍由人作出。
3. 信任清单是本地用户文件。文件所有者可自行修改它；进程内排队不协调其他进程；已有 `.bitori` 目录权限不会自动收紧。权限位不能抵御同一 OS 账户的恶意程序。
4. 当前聊天启用 bypass 后，副作用调用仍会绕过逐项审批，直到切换聊天、切回其他档位或进程退出。二次确认减少误触，但不替代判断。
5. trace、历史会话和归档可能保留模型复述的未知机密。已知配置秘密可脱敏，未知秘密须在分享前人工检查；POSIX 文件权限不能限制同一账户内的其他程序。

2026-11-03 用户曾接受当时列出的五项残留风险。后续集成轮已增加上述控制；接受记录保留为历史决定，不表示风险已消失。变更与复核见[决策记录](../decisions/0002-accept-current-security-residual-risks.md)。

## 修复记录

- 2026-11-01：审批四选项桌面统一、`/undo` 快照撤销、权限档位提示、工作区信任清单与诊断检查、探测脱敏测试补齐。
- 2026-11-03：会话批准绑定会话 ID；未信任工作区默认拒载项目配置与上下文；bypass 改为二次确认且仅会话有效；信任清单使用私有权限、符号链接防护与原子替换；trace/归档文件设置私有权限；审批文案展示参数和副作用提示。
