# Bitori

Bitori 是面向软件工作区的 AI 助手，提供流式对话、工具调用和本地会话存储。项目提供终端入口，以及正在开发的 Linux 桌面客户端。产品目标与状态见 [产品与路线图](docs/product.md)，源码入口见 [架构](docs/architecture.md)。

## 能力

- 支持 Anthropic Messages、OpenAI Responses 和 OpenAI Chat Completions；支持流式输出、Anthropic thinking、多会话和 SQLite 持久化。
- Agent 可多轮调用工具，支持取消、Plan/Do、逐轮及累计 token 用量；默认单任务最多 20 轮，连续三轮只调用未知工具会停止。取消或流错误会保留已有内容，不自动续跑。
- 六个基础文件、搜索和命令工具，以及 Skill、SubAgent、Teams、Worktree 等扩展工具；MCP 支持 stdio 和 Streamable HTTP。
- 上下文管理包括工具结果预算、自动摘要和 `/compact`（别名 `/c`）；指令支持 `@include`，长期记忆有 `MEMORY.md` 索引。Slash Command、Skill、Hook 支持项目扩展。
- 本地日志、请求 trace、用量统计及 `Ctrl+T` 调试面板辅助排查。

默认权限档自动放行工作区内的只读基础工具，对写入、命令和远端工具请求审批；规则或权限档可改变决定，见 [安全说明](SECURITY.md)。获批命令仍可能访问网络、启动子进程或影响工作区外资源。连续只读调用可并发，写入和命令形成顺序屏障。`/plan` 切换到只读计划模式；`/do` 切回执行模式并执行当前会话最近的自然完成计划，没有计划时不会请求模型。

## 环境与启动

需要 Node.js 24、npm，支持 Windows 10/11、Linux 和 macOS。Windows 命令使用 PowerShell，其他平台使用 bash。准备配置后，在仓库根目录运行：

```sh
npm ci
npm run build
npm link
bitori --help
bitori --profile claude-main
```

Linux 桌面端开发入口：

```sh
npm ci
npm run desktop
```

启动后选择并信任工作区，再选择模型配置。桌面端沿用相同的用户配置和会话数据库；工作区的 MCP 配置与 Hook 可能执行命令，只应打开可信目录。需要中文字体以正常显示中文界面。构建 Linux AppImage 和 deb 使用 `npm run desktop:package`，产物位于 `release/`；当前尚未发布安装包。

终端开发可用 `npm run dev -- --profile claude-main`。无头单任务也可用 `bitori exec --profile claude-main --task "检查项目" --workspace . --json`；无审批界面时，需要审批的副作用调用会被拒绝，已由规则或权限档放行的调用仍会执行。

## 配置

将配置放在用户主目录的 `~/.bitori/config.yaml`（Windows 为 `%USERPROFILE%\.bitori\config.yaml`），同目录必须有 `.env`，可从 [配置示例](examples/config.example.yaml) 开始。进程环境变量优先于 `.env`；未配置密钥的 profile 在被选中时才报错。终端会话数据库为 `~/.bitori/bitori.db`；`exec` 使用目标工作区的 `.bitori/bitori.db`。项目级 `.bitori/config.yaml` 只承载 MCP Server，同名项完整覆盖用户级配置。

```yaml
profiles:
  - name: claude-main
    protocol: anthropic
    model: claude-model-id
    base_url: https://api.anthropic.com
    api_key: ${ANTHROPIC_API_KEY}
    thinking: true

  - name: openai-responses
    protocol: openai-responses
    model: model-id
    base_url: https://api.openai.com/v1
    api_key: ${OPENAI_API_KEY}

  - name: compatible-chat
    protocol: openai-chat
    model: model-id
    base_url: https://example.com/v1
    api_key: ${COMPATIBLE_API_KEY}

mcp_servers:
  filesystem:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
    env:
      FILESYSTEM_TOKEN: ${MCP_FILESYSTEM_TOKEN}

  remote-search:
    transport: http
    url: https://example.com/mcp
    headers:
      Authorization: Bearer ${MCP_REMOTE_TOKEN}
```

`thinking` 仅适用于 Anthropic，可取 `false`、`true`、`{type: adaptive}`，或：

```yaml
thinking:
  type: manual
  budget_tokens: 4096
  max_tokens: 8192
```

`.env` 只保存密钥值，不要提交到版本控制：

```dotenv
ANTHROPIC_API_KEY=replace-with-your-key
OPENAI_API_KEY=replace-with-your-key
COMPATIBLE_API_KEY=replace-with-your-key
MCP_FILESYSTEM_TOKEN=replace-with-your-token
MCP_REMOTE_TOKEN=replace-with-your-token
```

配置只有一个 profile 时会直接进入聊天；多个 profile 时显示选择页，也可运行 `bitori --profile <name>` 直接选择。

MCP 使用 `2025-06-18` 协议版本，以 `initialize` / `notifications/initialized` 完成握手，再分页调用 `tools/list`。注册名为 `mcp__<server>__<tool>`；远端工具默认按有副作用调用处理，会进入现有权限与审批链路。单个 Server 连接或发现失败只在 stderr 告警，不影响其他 Server。当前不处理 MCP resources、prompts、sampling、健康检查或自动重连。

项目级 stdio 配置会在启动时执行其中的 `command`，因此只应在可信工作区中启用或提交 `.bitori/config.yaml`。

## 终端快捷键

| 键位 | 行为 |
|---|---|
| Enter | 发送；消息焦点时展开/折叠 thinking |
| Ctrl+C | 生成时取消；空闲时退出 |
| Ctrl+N / Ctrl+O | 新建会话 / 打开历史会话 |
| Ctrl+T | 切换调试面板 |
| Tab | 切换输入/消息焦点 |
| PageUp / PageDown | 滚动消息 |
| Up / Down | 在消息或会话列表中选择 |
| Esc | 关闭会话列表 |

## 排查和维护

`bitori trace show <sessionId>`、`bitori trace tail --session <sessionId>`、`bitori usage stats` 和 `bitori sessions list` 用于查看本地记录；`bitori --help` 列出完整参数。trace 可导出或离线回放；默认导出脱敏，`--raw` 会关闭导出脱敏。日志和 trace 仍可能包含代码与对话内容，分享前请审查。

- [架构与数据路径](docs/architecture.md)
- [开发、测试与发布](docs/development.md)
- [产品目标和路线图](docs/product.md)
- [贡献指南](CONTRIBUTING.md)、[安全策略](SECURITY.md)、[变更记录](CHANGELOG.md)

目前不支持多模态、多个用户任务并行、云同步、会话导入或自动断点续跑；不估算 token 成本，也不发送遥测。实际供应商兼容性需要针对所用端点验证。
