# 当前架构

核对日期：2026-10-27。以下是代码导航与主要数据路径，非完整依赖图。

```mermaid
flowchart LR
  CLI["CLI: src/bin, src/cli"] --> TUI["终端 UI: src/tui"]
  CLI --> Exec["单任务: src/cli/exec.ts"]
  Desktop["Electron: src/desktop"] --> Chat
  TUI --> Chat["会话控制: src/chat"]
  Exec --> Chat
  Chat --> Runner["Agent loop: src/agent"]
  Runner --> Provider["模型协议: src/providers"]
  Runner --> Tools["工具与权限: src/tools"]
  Tools --> MCP["MCP: src/mcp"]
  Chat --> Storage["存储 worker: src/storage"]
  Runner --> Trace["追踪: src/trace"]
```

入口 `src/bin/bitori.ts` 解析参数，`src/cli/bootstrap.ts` 加载配置、设置日志与脱敏，选择终端、`exec` 或观察子命令。终端使用 Ink/React 渲染；Linux Electron 入口通过 preload 和 IPC 连接界面与同一会话控制器。`src/app/runtime.ts` 是 CLI 与桌面端共用的组合根，统一创建模型客户端、工具系统、MCP、Hook、仓储和控制器。`ChatController` 管理会话状态和事件投影，`session-prompt.ts` 负责会话提示的组装，`AgentRunner` 驱动模型请求、工具执行和回写。`src/prompt/` 组装提示，`src/compact/` 处理上下文压缩。不同供应商通过 `src/providers/` 适配。

Provider 请求提供 `items` 时始终使用该有序上下文，即使它为空或渲染后为空；只有未提供 `items` 才使用兼容字段 `messages`。流中的工具调用由 `StreamCollector` 汇集，再由 `ToolPolicy` 校验和分类。

`src/tools/create-tool-system.ts` 注册六个基础工具及扩展工具；内置工具的 JSON Schema 由 Zod 输入 schema 生成。`permission-engine.ts` 先处理危险命令和文件真实路径，再应用规则、权限档及审批。文件路径边界不限制获准命令或 MCP 的外部访问。`src/mcp/` 负责发现、传输和适配；`src/skills/`、`src/hooks/`、`src/subagents/`、`src/teams/`、`src/worktree/` 实现对应扩展。关闭控制器时会取消并等待后台记忆提取；工具系统关闭时等待 MCP 和 Agent 服务清理。

`src/storage/repository.ts` 通过 worker 操作 SQLite，Agent Run/Iteration 是当前的回合写入接口；旧数据库中的消息和工具记录仍可读取。终端默认使用用户目录数据库，`exec` 使用工作区数据库。日志、每会话 JSONL trace 和技能/命令统计在用户目录的 `logs/`、`traces/`、`usage/`。trace 写入包含脱敏处理，但可能含工作区内容；不可视为无敏感数据。trace 默认保留 30 天，日志默认 7 天，配置见 `src/config/schema.ts`。

测试分布在 `tests/unit/`、`tests/integration/`、`tests/tui/` 和 `tests/acceptance/`；基准任务在 `benchmarks/`。从一次调用追踪时可依次查看 `src/chat/agent-controller.ts`、`src/agent/runner.ts`、`src/tools/executor.ts` 和对应 provider、存储或 trace 测试。

## 桌面进程边界

Linux 桌面端选择 Electron，以复用 TypeScript 业务核心和 SQLite Worker，代价是更大的发行包和运行时资源占用。业务控制器、配置、存储和工具执行留在主进程；渲染进程开启沙箱和上下文隔离，通过 preload 的受限 IPC 操作界面，模型与工具内容按文本渲染。切换工作区前要求确认信任，再重建工作区服务。验收与发布范围统一见 [产品状态](product.md)，不另行维护一份桌面状态记录。
