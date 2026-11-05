# 配置与安全

首次启动、聊天与附件操作见[项目 README](../README.md)。

## 本地数据与信任

| 位置 | 内容 |
|---|---|
| `~/.bitori/` | 用户 config.yaml、凭据 .env、默认会话数据库、日志、trace、usage、信任清单及用户扩展 |
| `<工作区>/.bitori/` | 项目配置、权限、记忆及扩展；使用相关功能时还会产生工具输出、撤销快照、worktree 或 exec 会话数据库 |

项目 `.bitori/` 已被 [Git 忽略](../.gitignore)，不全是缓存。删除会丢失其中的状态；需要共享的配置须先审查，不提交密钥、批准记录和数据库。

未信任工作区不加载项目 MCP/Hooks、指令、记忆、skills、commands、agents 与权限文件。审查后用 `bitori trust [path]` 或桌面“信任并打开”登记，`bitori trust [path] --revoke` 撤销；清单位于 `~/.bitori/trusted-workspaces.json`，doctor 会报告信任状态。

## 模型配置

首次启动生成用户配置。按[环境变量示例](../.env.example) 填写 `LLM_API_KEY`、`LLM_MODEL`、`LLM_BASE_URL`，再运行 `npm run dev -- doctor` 检查连接。

- 协议支持 `anthropic`、`openai-chat`、`openai-responses`、`qoder`。优先级为 YAML 的 protocol > 同前缀 `<前缀>_PROTOCOL` > [地址与密钥形状推断](../src/config/protocol.ts)。无法识别时回退 openai-chat，需用 doctor 核对。
- Anthropic 网关地址填接口根，由 SDK 拼接 `/v1/messages`；OpenAI 兼容地址通常填到 `/v1`。Qoder 使用 `https://api.qoder.com.cn` 或 `https://api.qoder.com`，连接官方 Cloud Agents，复用账号中的 bitori Environment 与 Agent，在本地执行 custom tools。
- YAML 的 api_key 必须完整引用 `${ENV_NAME}`；model、base_url 也支持变量引用。缺失引用报错，进程环境优先于 `.env`。
- 多配置使用全大写前缀的 `<前缀>_API_KEY`、`<前缀>_MODEL`、可选的 `_BASE_URL` 和 `_PROTOCOL`，派生 profile 名为小写前缀。Qoder 必须提供地址，其他协议可使用官方默认地址。不完整组跳过，显式 profile 及其已引用变量组不会重复派生；`profiles: []` 可完全依赖变量组。模板 LLM_* 未填不阻塞其他完整组，选中不可用的 default 时才提示补齐。
- thinking 仅适用于 Anthropic，支持 false、true、adaptive 或 manual；manual 的 budget_tokens 至少 1024，且小于同一 thinking 对象的 max_tokens。context_window 为正整数；models 可映射 SubAgent 逻辑模型名到 profile。

用 `--profile <name>` 选择配置，TUI `/model` 和桌面模型菜单查询真实模型列表。字段与约束以[配置 schema](../src/config/schema.ts) 为准。

## MCP

用户 config.yaml 支持 mcp_servers；项目 `.bitori/config.yaml` 只允许此字段，同名服务完整覆盖用户配置。引用的环境变量在加载时展开，缺失即报错。

| 传输 | 必填 | 可选 |
|---|---|---|
| stdio | transport: stdio、command | args、env |
| http | transport: http、url | headers |

stdio 执行本地程序，HTTP 会向对应服务发送数据，只启用已审查的服务。

## 权限规则与审批

规则依次加载用户 permissions.yaml、项目 permissions.yaml 和 permissions.local.yaml；项目文件需工作区受信任。只有 local 文件决定初始档位，默认 default。例如：

```yaml
rules:
  - tool: write_file
    pattern: 'docs/**'
    decision: ask
  - tool: run_command
    pattern: 'git push*'
    decision: deny
```

文件工具匹配路径，find_files 匹配 pattern，run_command 匹配完整命令；search_text 优先匹配 filePattern，否则匹配完整参数 JSON。MCP 和其他扩展匹配完整参数 JSON。支持 glob `*`、`**`、`?`，默认忽略大小写；exact: true 按原文精确比较。这些匹配不解析 shell 命令。

先检查危险命令黑名单和文件工具的工作区边界，再应用规则，优先级为 deny > ask > allow。

| 档位 | 行为 |
|---|---|
| default | 默认放行只读调用，其他调用需审批 |
| strict | 不采纳 allow，未拒绝的调用均需审批 |
| bypass | 跳过 ask 与无规则调用的审批，仍执行 deny、黑名单和路径检查 |

`/permission default`、`/permission strict` 写入项目 local 文件。启用 bypass 须在同一聊天 60 秒内依次输入 `/permission bypass`、`/permission bypass confirm`；切换聊天立即清除，不持久化。旧配置的 mode: bypass 降为 default。

审批支持一次、会话、永久允许和拒绝。会话批准绑定当前聊天，仅在当前进程内有效；永久批准写入 local 文件，使用精确 allow 规则，仍受 deny、ask 和 strict 约束。`exec` 无交互审批，需审批的调用会被拒绝。实现见[权限引擎](../src/tools/permission-engine.ts)。

## 图片附件

格式、大小限制和操作见[项目 README](../README.md)。图片内嵌保存到本地消息，不依赖原文件；仅支持本地图片，不支持图片 URL、音频和视频。未发送草稿只保留在当前界面内存。

Anthropic、OpenAI Chat 和 Responses 会构造图片请求，实际模型与网关须支持 VLM；Qoder 当前在请求前拒绝图片。程序不会丢图后按纯文本重发，图片 token 预算仅为估算。

## 会话导入与导出

```sh
bitori sessions list --profile <name>
bitori sessions export <sessionId> --out <path> --profile <name>
bitori sessions import <path> --profile <name> --json
```

源码运行将 `bitori` 换为 `npm run dev --`。单 profile 可省略 --profile，多个必须指定；导出限当前 profile，导入归入所选 profile 并新建会话。TUI 使用 `/export`、`/import`，桌面在侧栏操作；生成中需先等待或停止，导出不覆盖已有文件。

归档为 format: bitori-session、version: 1 的 UTF-8 JSON，最大 16 MiB，包含可见消息、工具参数与结果、回合和内嵌图片，排除配置、凭据字段、隐藏 thinking、Provider 私有状态与恢复检查点。`sessions show --json` 是诊断输出，不是交换归档。

导入验证结构与引用、重建 ID 并在事务中写入；不读取外部图片、不执行归档工具，也不自动续跑导入回合。完整限制见[归档契约](../src/storage/archive.ts)。

## 自动恢复

TUI、桌面只自动恢复因进程中断留下的回合；其他实例仍在运行、手动取消、失败、正常结束和导入的回合不自动恢复，exec 也不恢复历史任务。恢复沿用迭代次数与累计用量，已完成工具结果进入上下文，不直接重放调用。

若中断时有结果不确定的写入、命令或其他非只读调用，先检查实际状态，再用 TUI `/resume` 或桌面确认继续。后续模型调用仍适用当前权限规则；恢复不保证外部副作用恰好执行一次。

## 指令与扩展

用户扩展位于 `~/.bitori/`，项目扩展位于已信任工作区的 `.bitori/`。

| 类型 | 文件与行为 |
|---|---|
| 指令 | 按用户目录、项目目录、工作区根顺序加载；每处优先 BITORI.md，否则 AGENTS.md。@include/@import 相对当前文件，最多嵌套五层，不能越过用户目录或工作区边界 |
| Skills | skills/*.md 或 skills/名称/SKILL.md，frontmatter 需 name，可设 description、mode: inline；项目同名覆盖用户。只支持内联，allowed-tools、fork-context、model 等不支持字段会拒绝激活；load_skill 暂无参数输入，$ARGUMENTS 替换为空 |
| Commands | commands/*.md，一级子目录形成命名空间。内置、用户、项目按序注册，同名不覆盖；$ARGUMENTS 替换输入，没有占位符则追加 |
| SubAgents | agents/*.md，需 name，可设 description、model、system_prompt，正文为默认提示；项目 > 用户 > 内置。仅一次文本咨询，无工具、工作区读取和后台执行，相关不支持字段会拒绝加载 |
| Hooks | hooks.yaml 按用户、项目顺序追加，支持 command、prompt、http，暂不支持 agent。pre_tool_use、permission_request 消费拒绝结果且禁止 async；reject: true 时失败默认拦截，failure_policy: open 可放行。HTTP 支持超时和取消，发送事件上下文 |

command Hook 不经过 shell，command 为可执行文件、args 为固定参数；动态事件从 `BITORI_HOOK_CONTEXT` 环境变量读取 JSON，不拼接进命令源码。例如：

```yaml
- event: pre_tool_use
  action:
    type: command
    command: node
    args: [/absolute/path/to/hook.mjs]
```

脚本路径须替换为实际路径。事件与条件见[Hook 类型](../src/hooks/types.ts)和[执行引擎](../src/hooks/engine.ts)。

## 日志与安全边界

- logging.level 支持 debug/info/warn/error；logging.retention_days 默认 7 天，trace.retention_days 默认 30 天。日志、会话 JSONL trace 和 usage 保存在用户目录。
- 文件工具检查真实路径；获准的命令与 MCP 可访问工作区外部，权限规则不是操作系统沙箱。撤销仅在文件仍等于 Bitori 写入结果时生效。
- 信任、审批与 bypass 确认不能保证模型不受恶意内容影响，或用户不被诱导批准危险调用。
- 日志、trace 和 Provider 错误默认脱敏已知配置秘密，trace --raw 保留原始内容；未知机密和工作区内容仍可能出现在历史与导出中，分享前须检查。
- POSIX 上信任清单、归档及 trace 导出使用私有权限。信任清单拒绝符号链接和损坏内容，原子写入只协调当前进程；已有项目目录权限不会自动收紧，同一 OS 账户的恶意程序仍可访问数据。
- 桌面渲染进程隔离并开启沙箱，通过受限 IPC 调用主进程；Markdown 不执行 HTML、不加载远程图片，只允许 HTTP(S)/mailto 外链，API key 不传给界面。
