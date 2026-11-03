# 配置、扩展与权限参考

本文描述当前源码的配置入口；真实供应商、扩展和平台行为需在所用环境单独验证。用户级目录是 `~/.bitori/`，项目级目录是工作区根目录下的 `.bitori/`。项目的 [`.gitignore`](../../.gitignore) 默认忽略整个 `.bitori/`；要共享其中的配置，先审查内容，再有意调整忽略规则或选择性纳入版本控制，切勿提交密钥、本地批准记录或会话数据库。

## 模型和 MCP

从 [环境变量示例](../../.env.example) 开始，把它放到 `~/.bitori/.env`；`~/.bitori/config.yaml` 首次启动时自动生成，通常不需要手写。在 `.env` 填写 `LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY`，不要按供应商写死变量名。加载后至少需要一个可用 profile；`profiles` 可留空，由完整环境变量组派生；`protocol` 是接口方言（`openai-chat`、`openai-responses`、`anthropic` 或 `qoder`），不是供应商名称。`model` 和 `base_url` 支持字面量或 `${ENV_NAME}` 引用，`api_key` 必须是完整的 `${ENV_NAME}` 引用。变量在加载时展开，缺失会报错；URL 在展开后校验为 HTTP(S)，实际进程环境优先于 `.env`。`thinking` 仅适用于 Anthropic，可设为 `false`、`true`、`{type: adaptive}`，或设为 `type: manual` 并提供小于 `max_tokens` 的 `budget_tokens`（至少 1024）。可选 `context_window` 为正整数。可通过 `models` 映射 SubAgent 的逻辑模型名到 profile 名。

`protocol: qoder` 走官方 Cloud Agents（PAT 前缀 `pt-` 或 SAT），不是 OpenAI Chat Completions。`base_url` 填 `https://api.qoder.com.cn`（国内）或 `https://api.qoder.com`（国际）；`model` 可用官方 id（如 `dfmodel`）或控制台展示名（如 `DeepSeek-Flash`）。启动后会在 Qoder 账号下复用名为 `bitori` 的 self_hosted Environment 与 Agent，把 Bitori 工具注册为 client-side custom tools 并在本地执行。

用户级 `config.yaml` 可包含 `mcp_servers`；项目级同名文件只允许 `mcp_servers`，同名服务完整覆盖用户级服务。stdio 服务配置 `transport: stdio`、`command`，可选 `args` 和 `env`；HTTP 服务配置 `transport: http`、`url`，可选 `headers`。命令、参数、环境值、URL 和 header 引用的环境变量在加载时展开，缺失即报错；示例中的 HTTP URL 是占位符，不是可用服务。stdio 服务会执行配置的命令，HTTP 服务会接收发往它的数据；只启用可信服务，并先检查命令、地址和凭据。项目级扩展（MCP/Hooks）属于工作区自带内容：**未信任的工作区默认拒载**项目级 `.bitori/config.yaml` 的 MCP 与 `hooks.yaml`（启动时会在 warnings 中说明）。clone 的仓库确认后用 `bitori trust [path]` 登记（清单在 `~/.bitori/trusted-workspaces.json`，`--revoke` 撤销）；桌面选择工作区时的确认对话框会自动登记。`bitori doctor` 报告工作区信任状态。

### 只用一组 LLM_* 变量（默认 profile）

`LLM_API_KEY`、`LLM_BASE_URL` 和 `LLM_MODEL` 是模板中 `default` profile 的连接变量，也是手动 E2E 工作流使用的变量名。首次启动自动创建配置文件；在 `~/.bitori/.env` 中填写供应商提供的值后，重新启动。本文不提供凭据样例。

`config.yaml` 中的 `api_key` 必须引用环境变量，不能填写密钥字面量。模板已经引用 `LLM_*`，通常只需填写 `.env`。`protocol` 可显式设置，也可按地址与密钥形状识别。

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

Anthropic 兼容网关的 `base_url` 填接口根，SDK 自己拼 `/v1/messages`（填 `https://host/v1` 会变成 `/v1/v1/messages`）；`bitori doctor` 的模型列表同样取自 `{base_url}/v1/models`，并按官方 SDK 的方式用 `x-api-key` 认证。OpenAI 兼容网关的 `base_url` 填到 `/v1` 为止，模型列表取自 `{base_url}/models`，用 `Authorization: Bearer`。

若想连 `config.yaml` 都不写 profile，把它的 `profiles` 留空（`profiles: []`）：此时变量组会自行派生出名为 `llm` 的 profile，协议同样按上面规则识别。注意 `default` profile 一旦引用了 `${LLM_API_KEY}`，同前缀的变量组就不再重复派生，所以两种写法只能选一种。

### 多个 Provider：只填 .env

每个 Provider 使用一组全大写前缀变量。`<前缀>_API_KEY` 和 `<前缀>_MODEL` 必需，派生 profile 名为前缀的小写形式。`<前缀>_BASE_URL` 对 Anthropic 和 OpenAI 兼容协议可省略，使用官方默认端点；Qoder 必须提供。`<前缀>_PROTOCOL` 可指定 `openai-chat`、`openai-responses`、`anthropic` 或 `qoder`，省略时按上述规则推断。

不完整的变量组会被跳过，诊断信息会列出缺项。`config.yaml` 显式定义的 profile 优先，它引用过的变量组不会重复派生。模板的 `LLM_*` 未填不会阻塞其他完整 profile；选中不可用的 `default` 时才提示补齐。`bitori doctor` 可逐个检查连接。多 profile 启动时可选择配置，或用 `--profile <name>` 指定。

TUI `/model` 与桌面模型菜单会向 Provider 查询真实模型列表（Qoder/Anthropic/OpenAI 兼容端点的 `/models`），可在 profile 内直接选择模型；无法列表的端点会显示原因而不是伪造列表。连接故障可用 `bitori doctor` 或界面内的“模型/连接测试”定位（区分凭据、网络、协议不匹配与模型不存在）。

## 图片附件

图片作为消息附件保存到本地会话数据库，并在包含该消息的模型请求中发送给选定的 Provider。图片内容内嵌保存，之后不依赖原文件路径。当前只支持本地图片，不支持通过 URL 获取图片，也不提供音频或视频输入。

| 项目 | 限制或行为 |
|---|---|
| 格式 | PNG、JPEG、GIF、WebP；读取时校验文件内容，不能只改扩展名 |
| 单张大小 | 1 字节至 4 MiB，包含上限 |
| 每条消息 | 最多 4 张，原始图片字节合计不超过 8 MiB |
| 尺寸 | 宽、高分别不超过 8192 像素，总像素不超过 20,000,000 |
| TUI | `/attach <path>` 添加一张，可重复执行；含空格的路径可加引号；`/attachments clear` 清除待发送图片 |
| 桌面 | 输入框旁“图片”选择文件，“粘贴”读取剪贴板，也支持在输入框粘贴图片；剪贴板内容转为 PNG 后校验 |
| 显示 | TUI 显示文件名和 MIME 类型；桌面显示预览，并可移除待发送图片 |

添加后可输入文字或直接发送图片。未发送附件与文字草稿按会话隔离，仅保留在当前界面内存。读取失败、超限或校验不通过时显示错误。

Anthropic、OpenAI Chat 和 OpenAI Responses 适配器会构造各自的图片请求，实际 endpoint 与模型仍需支持图片。Qoder 当前在请求前明确拒绝图片输入。模型拒绝图片时应改用支持图片的模型或移除附件，程序不会静默丢图并按纯文本重发。图片 token 预算是估算，不能当作供应商的精确计费结果。

## 会话导入与导出

`bitori sessions export` 生成可交换归档；`sessions show --json` 是诊断输出，不能代替归档格式。已构建 CLI 的调用形式如下，源码运行时可把 `bitori` 替换为 `npm run dev --`：

```sh
bitori sessions list --profile <name>
bitori sessions export <sessionId> --out <path> --profile <name>
bitori sessions import <path> --profile <name> --json
```

单 profile 可省略 `--profile`；多个 profile 必须指定。导出只能读取当前 profile 的会话。导入归入指定的当前 profile，不要求归档中的旧 profile 存在。

TUI 使用 `/export <path>` 导出当前会话，`/import <path>` 导入并切换到新会话；路径支持引号。桌面侧栏的“导出当前”和“导入会话”分别打开保存与文件选择对话框。交互界面生成期间不能导入或导出，应先等待或停止任务。导出不覆盖已有文件，需选择新路径。

归档封装包含 `format: "bitori-session"`、`version: 1` 和 `conversation`，UTF-8 JSON 文件最大 16 MiB。归档包含可见消息、工具参数与结果、回合记录和内嵌图片，不包含配置、凭据字段、隐藏 thinking、Provider 私有状态或自动恢复检查点。校验还限制消息数为 10,000、工具调用数为 15,000、回合数为 5,000，并检查 ID 引用与数据结构。附件仍受上述图片限制。

导入会生成新的会话、消息、回合和工具记录 ID，并在事务内写入，校验失败不会留下部分会话。导入不会读取归档指向的外部图片文件，不会重放工具，不会把导入的运行中回合自动续跑。归档中的消息、工具参数、输出和图片可能含有敏感内容；排除凭据字段不等于对所有内容脱敏。

## 自动恢复

TUI 和桌面在加载或切换会话后检查最近回合，只恢复因进程中断留下的 `interrupted`、`process_interrupted` 回合。仍由其他实例运行的任务、手动取消、失败、正常停止和导入的回合不自动恢复。`exec` 显式关闭历史任务自动恢复。

恢复沿用原回合的持久化迭代次数与累计用量，不重置迭代预算；已完成工具的结果回到上下文，恢复机制不直接重放旧调用。如果中断时有结果不确定的写入、命令或其他非只读调用，界面先显示风险。检查工作区和外部状态后，在 TUI 输入 `/resume`，或在桌面恢复提示中点击确认继续。只读判断限于 `read_file`、`search_text` 和 `find_files`，其他工具保守地要求确认。

确认表示允许模型继续检查和处理任务，不证明之前的外部操作未执行。模型可以提出新的工具调用，这些调用仍受当前权限规则约束。会话批准只在当前进程中有效，重启后不会恢复；永久批准规则仍会加载。当前恢复机制不保证外部副作用恰好执行一次，也不提供云端恢复或跨设备同步。

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

聊天中可用 `/permission strict`、`/permission default` 或 `/permission bypass` 切换档位，写入项目的 `permissions.local.yaml`。终端审批可选择一次、会话或永久批准；会话批准按当前聊天的会话 ID 保存在权限引擎内存中，不跨聊天复用，也不写入会话数据库；重建工具系统或重启后消失。永久批准写入项目 `permissions.local.yaml`，使用相应调用值的精确 allow 规则；已有 `deny`、`ask` 和 `strict` 仍按上述优先级生效。`exec` 没有交互审批，仍需审批的调用会被拒绝，已放行的调用仍会执行。
