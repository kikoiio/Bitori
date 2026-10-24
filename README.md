# Bitori

Bitori 是 Windows 优先的全屏终端 AI 对话客户端。它在 Anthropic Messages、OpenAI Responses 和 OpenAI Chat Completions 间提供一致的自主 Agent Loop、六个内置工具，以及启动时自动发现的 MCP 工具。

## 课程与文档

- 实战课程入口：[docs/learning/README.md](docs/learning/README.md)。
- 每阶段源码导读：`Project_Guide/sNN.md`，当前已覆盖 `s01`～`s14`。

## 核心能力

- **聊天与协议**：三协议流式输出、Claude extended thinking、多会话管理和 SQLite 持久化。
- **Agent Loop**：自主多轮工具调用、取消恢复、20 轮上限、Plan/Do 模式和逐轮/累计 Token 用量。
- **工具与权限**：六个内置工具、真实路径沙箱、三层规则、三档权限和人在回路审批；连续只读调用并发，写入和命令形成安全屏障。
- **MCP**：stdio/Streamable HTTP Server 发现、握手、工具适配、故障隔离与统一关闭。
- **上下文管理**：工具结果落盘预算、自动全量摘要、手动 `/compact`/`/c` 和压缩熔断恢复。
- **记忆**：指令文件 `@include` 展开、四类长期记忆提取和 `MEMORY.md` 轻量索引。
- **Slash Command 与 Skill**：统一命令注册表、别名、Markdown prompt 命令和使用统计；frontmatter 技能包、两级加载热更新与 ActiveSkills 环境注入。
- **Hook**：15 个生命周期事件、条件表达式、command/prompt/http 动作和 `pre_tool_use` 拦截。
- **SubAgent 与 Teams**：内置角色、三级加载、多层工具过滤、后台任务通知；团队花名册、成员文件邮箱、锁与游标恢复、进度状态。
- **Worktree**：安全 slug、快速恢复、创建后设置、变更保护与清理。

文件读取、查找和搜索自动执行，但始终受启动工作区真实路径边界约束。创建文件、修改文件和执行命令会逐项显示参数并等待 `Y/N` 决定。命令仅固定从工作区启动，获批命令仍可能访问网络、启动子进程或影响工作区外资源。

一次用户消息会自动经历多轮模型响应、工具执行和结果回写，直到模型不再请求工具。每次模型响应形成独立助手消息；单任务最多 20 次模型迭代，连续三轮只调用未知工具也会停止。取消或模型流错误会保留已收到内容和已完成结果，但不会自动重试。

输入 `/plan` 可把当前会话切换到 PLAN 模式：命令本身不请求模型，后续任务仍可持续读取、查找和搜索，但写入与命令会被结构化拦截。自然完成的最近计划会按会话保存；输入 `/do` 会切回 DO 模式并立即执行该计划。没有计划时 `/do` 不请求模型。

同一响应中的连续只读调用可并发；写入和命令按模型顺序形成安全屏障，继续逐项等待 `Y/N`。模式、计划、每轮消息、工具结果、停止原因和 Token 用量随 SQLite 会话保存。

## 环境与安装

- Windows 10/11
- Windows Terminal + PowerShell
- Node.js 24 LTS

```powershell
npm ci
npm run build
npm link
Bitori --help
```

开发时可直接运行：

```powershell
npm run dev -- --profile claude-main
```

## 配置

Bitori 固定从 `%USERPROFILE%\.bitori\config.yaml` 读取 profile 和用户级 MCP Server，从同目录的 `.env` 读取变量；数据库保存在 `%USERPROFILE%\.bitori\bitori.db`。MCP Server 还会从当前工作区的 `.bitori\config.yaml` 合并，同名项由项目级完整覆盖。

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
```

配置只有一个 profile 时会直接进入聊天；多个 profile 时显示选择页，也可运行 `Bitori --profile <name>` 直接选择。

MCP 使用 `2025-06-18` 协议版本，以 `initialize` / `notifications/initialized` 完成握手，再分页调用 `tools/list`。注册名为 `mcp__<server>__<tool>`；远端工具默认按有副作用调用处理，会进入现有权限与审批链路。单个 Server 连接或发现失败只在 stderr 告警，不影响其他 Server。当前不处理 MCP resources、prompts、sampling、健康检查或自动重连。

项目级 stdio 配置会在启动时执行其中的 `command`，因此只应在可信工作区中启用或提交 `.bitori/config.yaml`。

## 快捷键

| 键位 | 行为 |
|---|---|
| Enter | 发送；消息焦点时展开/折叠 thinking |
| Ctrl+C | 生成时取消；空闲时退出 |
| Ctrl+N | 新建会话 |
| Ctrl+O | 打开历史会话 |
| Tab | 切换输入/消息焦点 |
| PageUp / PageDown | 滚动消息 |
| Up / Down | 在消息或会话列表中选择 |
| Esc | 关闭会话列表 |

## 质量检查

```powershell
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm run build
npm run check
node dist/bin/bitori.js --help
```

自动测试使用模拟 SDK、临时 SQLite 和本地 HTTP/SSE 服务，不要求真实 API Key 或外网。2026-08-23 已使用真实 DeepSeek Anthropic 兼容 profile 完成 Plan/Do、审批、拒绝、取消、恢复和持久化验收；官方 Anthropic、OpenAI Responses、OpenAI Chat 原生端点仍需按 `checklist.md` 分别验收。

## 当前不支持

Bitori 不支持多模态、多个用户任务并行、云同步、会话导入导出、断点续跑或非 Windows 平台。动态工具安装由 MCP、Slash Command、Skill、SubAgent、Teams 和 Worktree 的课程内机制覆盖。它不会自动批准副作用，不估算 token 成本，也不发送遥测。
