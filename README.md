# MyCode

MyCode 是 Windows 终端 AI 客户端。s03 在 Anthropic Messages、OpenAI Responses 和 OpenAI Chat Completions 间提供一致的自主 Agent Loop，以及六个工具：`read_file`、`write_file`、`edit_file`、`run_command`、`find_files` 和 `search_text`。

文件读取、查找和搜索自动执行，但始终受启动工作区真实路径边界约束。创建文件、修改文件和执行命令会逐项显示参数并等待 `Y/N` 决定。命令仅固定从工作区启动，获批命令仍可能访问网络、启动子进程或影响工作区外资源。

一次用户消息会自动经历多轮模型响应、工具执行和结果回写，直到模型不再请求工具。每次模型响应形成独立助手消息；单任务最多 20 次模型迭代，连续三轮只调用未知工具也会停止。取消或模型流错误会保留已收到内容和已完成结果，但不会自动重试。

输入 `/plan` 可把当前会话切换到 PLAN 模式：命令本身不请求模型，后续任务仍可持续读取、查找和搜索，但写入与命令会被结构化拦截。自然完成的最近计划会按会话保存；输入 `/do` 会切回 DO 模式并立即执行该计划。没有计划时 `/do` 不请求模型。

同一响应中的连续只读调用可并发；写入和命令按模型顺序形成安全屏障，继续逐项等待 `Y/N`。模式、计划、每轮消息、工具结果、停止原因和 Token 用量随 SQLite 会话保存。

MyCode 是一个 Windows 优先的全屏终端 AI 对话客户端，支持 Anthropic Messages、OpenAI Responses 和 OpenAI Chat Completions。它提供流式输出、Claude extended thinking、本地多会话管理和 SQLite 持久化。

## 环境与安装

- Windows 10/11
- Windows Terminal + PowerShell
- Node.js 24 LTS

```powershell
npm ci
npm run build
npm link
MyCode --help
```

开发时可直接运行：

```powershell
npm run dev -- --profile claude-main
```

## 配置

MyCode 固定读取 `%USERPROFILE%\.mycode\config.yaml` 和同目录的 `.env`，数据库固定保存在 `%USERPROFILE%\.mycode\mycode.db`。当前工作目录中的配置不会被读取。

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

配置只有一个 profile 时会直接进入聊天；多个 profile 时显示选择页，也可运行 `MyCode --profile <name>` 直接选择。

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
node dist/bin/mycode.js --help
```

自动测试使用模拟 SDK、临时 SQLite 和本地 HTTP/SSE 服务，不要求真实 API Key 或外网。2026-08-23 已使用真实 DeepSeek Anthropic 兼容 profile 完成 Plan/Do、审批、拒绝、取消、恢复和持久化验收；官方 Anthropic、OpenAI Responses、OpenAI Chat 原生端点仍需按 `checklist.md` 分别验收。

## 当前不支持

MyCode 不支持 MCP、动态工具安装、多模态、多个用户任务并行、云同步、会话导入导出、自动摘要、断点续跑或非 Windows 平台。它不会自动批准副作用，不估算 token 成本，也不发送遥测。
