# 配置、扩展与权限参考

本文描述当前源码的配置入口；真实供应商、扩展和平台行为需在所用环境单独验证。用户级目录是 `~/.bitori/`，项目级目录是工作区根目录下的 `.bitori/`。项目的 [`.gitignore`](../../.gitignore) 默认忽略整个 `.bitori/`；要共享其中的配置，先审查内容，再有意调整忽略规则或选择性纳入版本控制，切勿提交密钥、本地批准记录或会话数据库。

## 模型和 MCP

从 [环境变量示例](../../.env.example) 开始，把它放到 `~/.bitori/.env`；`~/.bitori/config.yaml` 首次启动时自动生成，通常不需要手写。在 `.env` 填写 `LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY`，不要按供应商写死变量名。`profiles` 至少包含一项；`protocol` 是接口方言（`openai-chat`、`openai-responses`、`anthropic` 或 `qoder`），不是供应商名称。`model` 和 `base_url` 支持字面量或 `${ENV_NAME}` 引用，`api_key` 必须是完整的 `${ENV_NAME}` 引用。变量在加载时展开，缺失会报错；URL 在展开后校验为 HTTP(S)，实际进程环境优先于 `.env`。`thinking` 仅适用于 Anthropic，可设为 `false`、`true`、`{type: adaptive}`，或设为 `type: manual` 并提供小于 `max_tokens` 的 `budget_tokens`（至少 1024）。可选 `context_window` 为正整数。可通过 `models` 映射 SubAgent 的逻辑模型名到 profile 名。

`protocol: qoder` 走官方 Cloud Agents（PAT 前缀 `pt-` 或 SAT），不是 OpenAI Chat Completions。`base_url` 填 `https://api.qoder.com.cn`（国内）或 `https://api.qoder.com`（国际）；`model` 可用官方 id（如 `dfmodel`）或控制台展示名（如 `DeepSeek-Flash`）。启动后会在 Qoder 账号下复用名为 `bitori` 的 self_hosted Environment 与 Agent，把 Bitori 工具注册为 client-side custom tools 并在本地执行。

用户级 `config.yaml` 可包含 `mcp_servers`；项目级同名文件只允许 `mcp_servers`，同名服务完整覆盖用户级服务。stdio 服务配置 `transport: stdio`、`command`，可选 `args` 和 `env`；HTTP 服务配置 `transport: http`、`url`，可选 `headers`。命令、参数、环境值、URL 和 header 引用的环境变量在加载时展开，缺失即报错；示例中的 HTTP URL 是占位符，不是可用服务。stdio 服务会执行配置的命令，HTTP 服务会接收发往它的数据；只启用可信服务，并先检查命令、地址和凭据。项目级扩展（MCP/Hooks）属于工作区自带内容：**未信任的工作区默认拒载**项目级 `.bitori/config.yaml` 的 MCP 与 `hooks.yaml`（启动时会在 warnings 中说明）。clone 的仓库确认后用 `bitori trust [path]` 登记（清单在 `~/.bitori/trusted-workspaces.json`，`--revoke` 撤销）；桌面选择工作区时的确认对话框会自动登记。`bitori doctor` 报告工作区信任状态。

### 只用一组 LLM_* 变量（默认 profile）

`LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` 是模板里 `default` profile 用的连接参数，也是 CI 手动 E2E 工作流读的那三个变量。本地只要它们：

```ini
# ~/.bitori/.env
LLM_API_KEY=<你的密钥>
LLM_BASE_URL=https://api.scnet.cn/api/llm/anthropic
LLM_MODEL=DeepSeek-V4.1-Flash-1017-Event
```

`~/.bitori/config.yaml` 不用写 `protocol`——协议会按地址与密钥形状自动识别：

```yaml
profiles:
  - name: default
    model: ${LLM_MODEL}
    base_url: ${LLM_BASE_URL}
    api_key: ${LLM_API_KEY}
```

识别规则按信号强度排列（`src/config/protocol.ts`）：

| 信号 | 结论 |
|---|---|
| 密钥以 `pt-` 开头 | `qoder`（Qoder PAT 形状） |
| 地址含 `qoder` | `qoder` |
| 地址含 `anthropic` 或 `claude` | `anthropic` |
| 地址含 `/responses` | `openai-responses` |
| 地址含 `chat/completions` | `openai-chat` |
| 其它 | `openai-chat`（兜底，最常见的 OpenAI 兼容接口） |

兜底是**弱推断**：`bitori doctor` 会写明"按最常见的 OpenAI 兼容接口处理"，地址看不出方言时应当手工指定。协议优先级是：`config.yaml` 里显式写 `protocol:` > `.env` 里同前缀的 `<前缀>_PROTOCOL` > 上述推断。`bitori doctor` 的「协议 <name>」一行会显示当前用的方言与依据。

Anthropic 兼容网关的 `base_url` 填接口根，SDK 自己拼 `/v1/messages`（填 `https://host/v1` 会变成 `/v1/v1/messages`）。OpenAI 兼容网关的 `base_url` 填到 `/v1` 为止。

若想连 `config.yaml` 都不写 profile，把它的 `profiles` 留空（`profiles: []`）：此时变量组会自行派生出名为 `llm` 的 profile，协议同样按上面规则识别。注意 `default` profile 一旦引用了 `${LLM_API_KEY}`，同前缀的变量组就不再重复派生，所以两种写法只能选一种。

### 多个 Provider：只填 .env

一个 Provider = `.env` 里一组同前缀变量，填完自动生效，`config.yaml` 不需要动：

```ini
# 前缀全大写；profile 名自动取前缀小写（OPENROUTER_ → openrouter）
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=deepseek/deepseek-chat

QODER_API_KEY=pt-...
QODER_BASE_URL=https://api.qoder.com.cn
QODER_MODEL=DeepSeek-Flash
QODER_PROTOCOL=qoder
```

规则：`<前缀>_API_KEY` + `<前缀>_MODEL` 必需；`<前缀>_PROTOCOL` 可选（默认 `openai-chat`，支持 `openai-chat | openai-responses | anthropic | qoder`）；`<前缀>_BASE_URL` 对 anthropic/OpenAI 兼容可省略（用官方默认端点），对 qoder 必填。不完整的变量组会被跳过，`bitori doctor` 列出缺哪一项。`config.yaml` 显式定义的 profile 优先，且它引用过的变量组不会重复派生；模板里 `LLM_*` 未填不再阻塞启动，只有选中 `default` profile 时才提示填写。填完运行 `bitori doctor` 即可逐个 profile 验证凭据、连接与模型。

TUI `/model` 与桌面模型菜单会向 Provider 查询真实模型列表（Qoder/Anthropic/OpenAI 兼容端点的 `/models`），可在 profile 内直接选择模型；无法列表的端点会显示原因而不是伪造列表。连接故障可用 `bitori doctor` 或界面内的“模型/连接测试”定位（区分凭据、网络、协议不匹配与模型不存在）。

## 日志与追踪

用户级 `config.yaml` 可选 `logging.level`（`debug` / `info` / `warn` / `error`）、`logging.retention_days` 和 `trace.retention_days`；缺省日志 7 天、trace 30 天。日志、每会话 JSONL 和 usage 写在 `~/.bitori/` 下对应目录。

## 指令与扩展

- 指令按用户级 `~/.bitori/`、项目级 `.bitori/`、工作区根的顺序加入提示；每个位置优先读取 `BITORI.md`，没有时读取 `AGENTS.md`，同一位置只选一个。`@include` 或 `@import` 相对于包含文件，用户级指令不能越出用户 `.bitori/`，项目指令不能越出工作区，最多嵌套五层；不存在的目标会留下提示。
- Skill 从用户和项目的 `.bitori/skills/` 加载，支持直接放 `.md` 文件，或放在子目录的 `SKILL.md`。frontmatter 至少需要 `name`，可填 `description` 和 `mode: inline`。当前只支持内联激活：声明 `allowed-tools`、`fork-context`、`model` 或其他 `mode` 值时激活会报错，并移除该名称已激活的旧内容；这些配置不能限制工具、派生会话或切换模型。同名项目 Skill 覆盖用户 Skill。正文支持 `$ARGUMENTS` 替换，但目前模型的 `load_skill` 工具没有参数输入，会用空字符串替换。
- Slash Command 从用户和项目的 `.bitori/commands/` 加载 `.md` 文件，一级子目录构成命名空间。内置命令先注册，用户级先于项目级；同名项不会覆盖已注册命令。正文中的 `$ARGUMENTS` 被参数替换，缺少占位符时参数追加到正文。
- SubAgent 从用户和项目的 `.bitori/agents/` 加载 `.md` 文件；frontmatter 需要 `name`，可设置 `description`、`model` 和 `system_prompt`，正文作为默认提示，`system_prompt` 存在时优先使用。当前仅支持基于提供内容的一次文本咨询，不能使用工具、读取工作区或后台运行；声明 `tools`、`disallowed_tools`、`max_turns`、`permission_mode` 或 `background` 的角色会被拒绝，空值和错误类型也不例外。项目级同名定义覆盖用户级，用户级覆盖内置定义。
- Hook 从用户级和项目级 `.bitori/hooks.yaml` 按顺序追加加载；动作支持 `command`、`prompt` 和 `http`；`agent` 动作尚不支持。`pre_tool_use` 与 `permission_request` 均消费拒绝结果且不允许 `async`；配置 `reject: true` 时失败默认拦截，`failure_policy: open` 可显式选择失败时放行。HTTP Hook 支持 `timeout_ms` 和取消，会向目标发送事件上下文。事件、条件和限制见 [`src/hooks/types.ts`](../../src/hooks/types.ts) 与 [`src/hooks/engine.ts`](../../src/hooks/engine.ts)。

command Hook 的 `command` 是可执行文件，`args` 是独立参数数组，全平台均不经过 shell。不再拆分 `command: "程序 参数"`，也不允许将 `$TOOL_ARGS.path`、`$MESSAGE` 等动态上下文插入命令或参数；从旧配置迁移时需要拆开固定参数，并在所调用程序中读取 `BITORI_HOOK_CONTEXT` 环境变量（完整事件的 JSON）。例如：

```yaml
- event: pre_tool_use
  action:
    type: command
    command: node
    args: [/absolute/path/to/hook.mjs]
```

脚本可用 `JSON.parse(process.env.BITORI_HOOK_CONTEXT)` 读取数据。脚本路径须替换为真实路径；若明确调用 bash/PowerShell 等解释器，只传可信的固定脚本，不把事件数据再拼接为待执行源码。

例如，将以下内容保存为项目 `.bitori/skills/review/SKILL.md`，模型调用该 Skill 时会载入正文：

```markdown
---
name: review
description: 按对话要求审查文件
---
根据当前对话确定审查范围，并说明发现与验证范围。
```

例如，项目 `.bitori/commands/explain.md` 可写为下列内容，在聊天中输入 `/explain src/index.ts`：

```markdown
---
description: 解释文件
argument-hint: 文件路径
---
解释 $ARGUMENTS 的职责。
```

## 权限规则与审批

权限规则从 `~/.bitori/permissions.yaml`、项目 `.bitori/permissions.yaml`、项目 `.bitori/permissions.local.yaml` 合并加载。只有 local 文件的 `mode` 决定初始档位；缺省为 `default`。例如项目规则可以写成：

```yaml
rules:
  - tool: write_file
    pattern: 'docs/**'
    decision: ask
  - tool: run_command
    pattern: 'git push*'
    decision: deny
```

规则支持当前注册的基础工具、扩展工具及 `mcp__<server>__<tool>`。匹配值为文件工具的路径、`find_files` 的 pattern、`run_command` 的完整命令；`search_text` 提供 filePattern 时匹配它，否则匹配完整参数 JSON。MCP 和其他扩展工具匹配完整参数 JSON。`*`、`**`、`?` 按 glob 匹配，普通匹配不区分大小写；`exact: true` 则按原文精确比较。自动生成的会话/永久批准使用 exact 规则，扩展工具的不同参数需要重新批准。规则不是 shell 解析器，不能将示例当作全面的命令安全策略。

判断先检查危险命令黑名单和基础文件工具的工作区路径，再检查所有匹配规则：`deny` 优先于 `ask`，`ask` 优先于 `allow`。`default` 默认放行只读调用，其他调用需审批；`strict` 不采纳 `allow`，未被拒绝的调用需审批；`bypass` 放行 `ask` 和无规则调用，但不会覆盖 `deny`、黑名单或路径检查。命令与 MCP 不受文件工具路径检查约束，这些机制均不是操作系统沙箱。

聊天中可用 `/permission strict`、`/permission default` 或 `/permission bypass` 切换档位，写入项目的 `permissions.local.yaml`。终端审批可选择一次、会话或永久批准；会话批准保存在当前权限引擎内存中，并非存入会话数据库，切换聊天会话不一定清除它，重建工具系统后消失。永久批准写入项目 `permissions.local.yaml`，使用相应调用值的精确 allow 规则；已有 `deny`、`ask` 和 `strict` 仍按上述优先级生效。`exec` 没有交互审批，仍需审批的调用会被拒绝，已放行的调用仍会执行。
