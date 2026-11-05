# 配置与安全

首次启动与聊天操作见[项目 README](../README.md)。

## 本地数据目录

| 位置 | 内容 |
|---|---|
| `~/.bitori/` | 用户配置 config.yaml、凭据 .env、默认会话数据库、日志、trace、usage、信任清单与用户扩展 |
| `<工作区>/.bitori/` | 项目 MCP/Hooks、权限规则、指令、记忆、skills、commands、agents；使用相关功能时还会生成工具输出、快照、worktree 或 exec 会话数据库 |

项目 `.bitori/` 已被 [`.gitignore`](../.gitignore) 忽略，是本地配置与数据，不全是缓存；删除会丢失其中的状态。需共享的配置应先审查再选择性纳入 Git，不提交密钥、批准记录和数据库。

## 模型和 MCP

从 [环境变量示例](../.env.example) 开始，把它放到 `~/.bitori/.env`；`~/.bitori/config.yaml` 首次启动时自动生成，通常不需要手写。在 `.env` 填写 `LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY`，不要按供应商写死变量名。加载后至少需要一个可用 profile；`profiles` 可留空，由完整环境变量组派生；`protocol` 是接口方言（`openai-chat`、`openai-responses`、`anthropic` 或 `qoder`），不是供应商名称。`model` 和 `base_url` 支持字面量或 `${ENV_NAME}` 引用，`api_key` 必须是完整的 `${ENV_NAME}` 引用。变量在加载时展开，缺失会报错；URL 在展开后校验为 HTTP(S)，实际进程环境优先于 `.env`。`thinking` 仅适用于 Anthropic，可设为 `false`、`true`、`{type: adaptive}`，或设为 `type: manual` 并提供小于 `max_tokens` 的 `budget_tokens`（至少 1024）。可选 `context_window` 为正整数。可通过 `models` 映射 SubAgent 的逻辑模型名到 profile 名。

`protocol: qoder` 走官方 Cloud Agents（PAT 前缀 `pt-` 或 SAT），不是 OpenAI Chat Completions。`base_url` 填 `https://api.qoder.com.cn`（国内）或 `https://api.qoder.com`（国际）；`model` 可用官方 id（如 `dfmodel`）或控制台展示名（如 `DeepSeek-Flash`）。启动后会在 Qoder 账号下复用名为 `bitori` 的 self_hosted Environment 与 Agent，把 Bitori 工具注册为 client-side custom tools 并在本地执行。

用户级 `config.yaml` 可包含 `mcp_servers`；项目级同名文件只允许 `mcp_servers`，同名服务完整覆盖用户级服务。stdio 服务配置 `transport: stdio`、`command`，可选 `args` 和 `env`；HTTP 服务配置 `transport: http`、`url`，可选 `headers`。命令、参数、环境值、URL 和 header 引用的环境变量在加载时展开，缺失即报错。stdio 服务会执行配置的命令，HTTP 服务会接收发往它的数据；只启用可信服务，并先检查命令、地址和凭据。未信任工作区默认拒载项目级 `.bitori/config.yaml` 的 MCP、`.bitori/hooks.yaml`、项目指令、`.bitori/memory`、skills、commands、agents、`permissions.yaml` 与 `permissions.local.yaml`。查看来源后用 `bitori trust [path]` 登记；清单位于 `~/.bitori/trusted-workspaces.json`，`--revoke` 可撤销。桌面选择工作区时的确认对话框会登记信任；`bitori doctor` 报告信任状态。信任意味着这些项目内容会参与模型上下文或运行时，确认前应审查。

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

添加、清除、预览和大小限制见[项目 README](../README.md)。图片内嵌保存到本地消息，之后不依赖原文件；仅支持本地图片，不支持图片 URL、音频和视频。未发送的文字与图片草稿只保留在当前界面内存。

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

POSIX 系统上，新建或复用的会话归档与 trace 导出文件权限设为 `0600`。Trace 默认脱敏；`--raw` 会保留原始内容。权限位限制其他系统账户读取，不会阻止同一账户的程序访问。导出仍可能包含未知机密，分享前请人工检查。

导入会生成新的会话、消息、回合和工具记录 ID，并在事务内写入，校验失败不会留下部分会话。导入不会读取归档指向的外部图片文件，不会重放工具，不会把导入的运行中回合自动续跑。归档中的消息、工具参数、输出和图片可能含有敏感内容；排除凭据字段不等于对所有内容脱敏。

## 自动恢复

TUI 和桌面在加载或切换会话后检查最近回合，只恢复因进程中断留下的 `interrupted`、`process_interrupted` 回合。仍由其他实例运行的任务、手动取消、失败、正常停止和导入的回合不自动恢复。`exec` 显式关闭历史任务自动恢复。

恢复沿用原回合的持久化迭代次数与累计用量，不重置迭代预算；已完成工具的结果回到上下文，恢复机制不直接重放旧调用。如果中断时有结果不确定的写入、命令或其他非只读调用，界面先显示风险。检查工作区和外部状态后，在 TUI 输入 `/resume`，或在桌面恢复提示中点击确认继续。只读判断限于 `read_file`、`search_text` 和 `find_files`，其他工具保守地要求确认。

确认表示允许模型继续检查和处理任务，不证明之前的外部操作未执行。模型可以提出新的工具调用，这些调用仍受当前权限规则约束。会话批准只在当前进程中有效，重启后不会恢复；永久批准规则仍会加载。当前恢复机制不保证外部副作用恰好执行一次，也不提供云端恢复或跨设备同步。

## 日志与追踪

用户级 `config.yaml` 可选 `logging.level`（`debug` / `info` / `warn` / `error`）、`logging.retention_days` 和 `trace.retention_days`；缺省日志 7 天、trace 30 天。日志、每会话 JSONL 和 usage 写在 `~/.bitori/` 下对应目录。

## 指令与扩展

- 指令按用户级 `~/.bitori/`、项目级 `.bitori/`、工作区根的顺序加入提示；每个位置优先读取 `BITORI.md`，没有时读取 `AGENTS.md`，同一位置只选一个。项目级指令仅在工作区信任后载入。`@include` 或 `@import` 相对于包含文件，用户级指令不能越出用户 `.bitori/`，项目指令不能越出工作区，最多嵌套五层；不存在的目标会留下提示。
- Skill 从用户和已信任项目的 `.bitori/skills/` 加载，支持直接放 `.md` 文件，或放在子目录的 `SKILL.md`。frontmatter 至少需要 `name`，可填 `description` 和 `mode: inline`。当前只支持内联激活：声明 `allowed-tools`、`fork-context`、`model` 或其他 `mode` 值时激活会报错，并移除该名称已激活的旧内容；这些配置不能限制工具、派生会话或切换模型。同名项目 Skill 覆盖用户 Skill。正文支持 `$ARGUMENTS` 替换，但目前模型的 `load_skill` 工具没有参数输入，会用空字符串替换。
- Slash Command 从用户和已信任项目的 `.bitori/commands/` 加载 `.md` 文件，一级子目录构成命名空间。内置命令先注册，用户级先于项目级；同名项不会覆盖已注册命令。正文中的 `$ARGUMENTS` 被参数替换，缺少占位符时参数追加到正文。
- SubAgent 从用户和已信任项目的 `.bitori/agents/` 加载 `.md` 文件；frontmatter 需要 `name`，可设置 `description`、`model` 和 `system_prompt`，正文作为默认提示，`system_prompt` 存在时优先使用。当前仅支持基于提供内容的一次文本咨询，不能使用工具、读取工作区或后台运行；声明 `tools`、`disallowed_tools`、`max_turns`、`permission_mode` 或 `background` 的角色会被拒绝，空值和错误类型也不例外。项目级同名定义覆盖用户级，用户级覆盖内置定义。
- Hook 从用户级和已信任项目的 `.bitori/hooks.yaml` 按顺序追加加载；动作支持 `command`、`prompt` 和 `http`；`agent` 动作尚不支持。`pre_tool_use` 与 `permission_request` 均消费拒绝结果且不允许 `async`；配置 `reject: true` 时失败默认拦截，`failure_policy: open` 可显式选择失败时放行。HTTP Hook 支持 `timeout_ms` 和取消，会向目标发送事件上下文。事件、条件和限制见 [`src/hooks/types.ts`](../src/hooks/types.ts) 与 [`src/hooks/engine.ts`](../src/hooks/engine.ts)。

command Hook 的 `command` 是可执行文件，`args` 是独立参数数组，全平台均不经过 shell。不再拆分 `command: "程序 参数"`，也不允许将 `$TOOL_ARGS.path`、`$MESSAGE` 等动态上下文插入命令或参数；从旧配置迁移时需要拆开固定参数，并在所调用程序中读取 `BITORI_HOOK_CONTEXT` 环境变量（完整事件的 JSON）。例如：

```yaml
- event: pre_tool_use
  action:
    type: command
    command: node
    args: [/absolute/path/to/hook.mjs]
```

脚本可用 `JSON.parse(process.env.BITORI_HOOK_CONTEXT)` 读取数据。脚本路径须替换为真实路径；若明确调用 bash/PowerShell 等解释器，只传可信的固定脚本，不把事件数据再拼接为待执行源码。

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

聊天中可用 `/permission strict` 或 `/permission default` 切换档位，设置会写入项目的 `permissions.local.yaml`。启用 bypass 需先输入 `/permission bypass`，再在同一聊天 60 秒内输入 `/permission bypass confirm`；切换聊天时立即清除该聊天的 bypass，且不会持久化。旧配置里的 `mode: bypass` 会忽略并恢复 `default`。未信任工作区的项目级 permission 文件均不加载。终端审批可选择一次、会话或永久批准；会话批准按当前聊天的会话 ID 保存在权限引擎内存中，不跨聊天复用，也不写入会话数据库；重建工具系统或重启后消失。永久批准写入项目 `permissions.local.yaml`，使用相应调用值的精确 allow 规则；已有 `deny`、`ask` 和 `strict` 仍按上述优先级生效。`exec` 没有交互审批，仍需审批的调用会被拒绝，已放行的调用仍会执行。

## 安全边界

- 项目内容、模型回复和工具输出可能包含恶意指令；信任与审批无法保证模型不受影响，或用户不被诱导批准危险调用。
- 文件工具检查真实路径，命令与 MCP 可在获准后访问工作区外部，权限规则不构成操作系统沙箱。撤销仅在当前文件仍等于 Bitori 写入结果时生效。
- 日志、trace 和 Provider 错误默认脱敏已知配置秘密，未知机密仍可能出现在历史、图片和导出中，分享前须检查；trace 的 `--raw` 保留原始内容。
- 信任清单拒绝符号链接和损坏内容，使用私有权限及原子写入，但只协调进程内写入；不会自动收紧已有项目目录权限。POSIX 私有权限不能防御同一 OS 账户的恶意程序。
- 桌面渲染进程隔离并开启沙箱，通过受限 IPC 访问主进程；Markdown 不执行 HTML、不加载远程图片，只允许 HTTP(S)/mailto 外链。API key 不传给界面。
