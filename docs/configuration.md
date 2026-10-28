# 配置、扩展与权限参考

本文描述当前源码的配置入口；真实供应商、扩展和平台行为需在所用环境单独验证。用户级目录是 `~/.bitori/`，项目级目录是工作区根目录下的 `.bitori/`。项目的 [`.gitignore`](../.gitignore) 默认忽略整个 `.bitori/`；要共享其中的配置，先审查内容，再有意调整忽略规则或选择性纳入版本控制，切勿提交密钥、本地批准记录或会话数据库。

## 模型和 MCP

从 [配置示例](../examples/config.example.yaml) 和 [环境变量示例](../examples/.env.example) 开始，替换模型 ID 与密钥。`profiles` 至少包含一项，`protocol` 为 `anthropic`、`openai-responses` 或 `openai-chat`；`api_key` 必须是完整的 `${ENV_NAME}` 引用。`thinking` 仅适用于 Anthropic，可设为 `false`、`true`、`{type: adaptive}`，或设为 `type: manual` 并提供小于 `max_tokens` 的 `budget_tokens`（至少 1024）。可选 `context_window` 为正整数。可通过 `models` 映射 SubAgent 的逻辑模型名到 profile 名。

用户级 `config.yaml` 可包含 `mcp_servers`；项目级同名文件只允许 `mcp_servers`，同名服务完整覆盖用户级服务。stdio 服务配置 `transport: stdio`、`command`，可选 `args` 和 `env`；HTTP 服务配置 `transport: http`、`url`，可选 `headers`。命令、参数、环境值、URL 和 header 引用的环境变量在加载时展开，缺失即报错。示例中的 HTTP URL 是占位符，不是可用服务。stdio 服务会执行配置的命令，HTTP 服务会接收发往它的数据；只启用可信服务，并先检查命令、地址和凭据。

## 指令与扩展

- 指令按用户级 `~/.bitori/BITORI.md`、项目级 `.bitori/BITORI.md`、工作区根 `BITORI.md` 的顺序加入提示，后面的说明靠后。`@include` 或 `@import` 引入的路径相对于包含文件，并受工作区边界及最多五层嵌套限制；不存在的目标会留下提示。仓库根的 [BITORI.md](../BITORI.md) 引入唯一规范 [AGENTS.md](../AGENTS.md)；Bitori 不自动发现 `AGENTS.md` 或 `AGENT.md`。
- Skill 从用户和项目的 `.bitori/skills/` 加载，支持直接放 `.md` 文件，或放在子目录的 `SKILL.md`。frontmatter 至少需要 `name`，可填 `description`、逗号分隔的 `allowed-tools`、`mode: fork`、`fork-context: recent` 或 `full`、`model`。同名项目 Skill 覆盖用户 Skill；正文可使用 `$ARGUMENTS`。
- Slash Command 从用户和项目的 `.bitori/commands/` 加载 `.md` 文件，一级子目录构成命名空间。内置命令先注册，用户级先于项目级；同名项不会覆盖已注册命令。正文中的 `$ARGUMENTS` 被参数替换，缺少占位符时参数追加到正文。
- SubAgent 从用户和项目的 `.bitori/agents/` 加载 `.md` 文件；frontmatter 需要 `name`，可设置 `description` 和 `model`。当前仅支持基于提供内容的一次文本咨询，不能使用工具、读取工作区或后台运行；配置 `tools`、`disallowed_tools`、`max_turns`、`permission_mode` 或 `background` 的角色会被拒绝。项目级同名定义覆盖用户级，用户级覆盖内置定义。
- Hook 从用户级和项目级 `.bitori/hooks.yaml` 按顺序追加加载；动作支持 `command`、`prompt` 和 `http`；`agent` 动作尚不支持。HTTP Hook 支持 `timeout_ms` 和取消；`reject: true` 的失败默认拦截，`failure_policy: open` 可显式选择失败时放行。`command` 可执行本地程序，`http` 可向外发送事件上下文；启用前审查来源和目标。事件、条件和限制见 [`src/hooks/types.ts`](../src/hooks/types.ts) 与 [`src/hooks/engine.ts`](../src/hooks/engine.ts)。

例如，将以下内容保存为项目 `.bitori/skills/review/SKILL.md`，模型调用该 Skill 时会载入正文：

```markdown
---
name: review
description: 检查指定文件
---
检查 $ARGUMENTS，并说明发现与验证范围。
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

规则支持六个基础工具及 `mcp__<server>__<tool>` 名称；匹配值分别来自文件路径、搜索模式、完整命令，或 MCP 参数的 JSON 字符串。`*`、`**`、`?` 按 glob 匹配，普通匹配不区分大小写；`exact: true` 则按原文精确比较。规则不是 shell 解析器，匹配完整命令字符串，不能将示例当作全面的命令安全策略。其他扩展工具不能通过上述名称规则单独配置，仍按工具 effect 和权限档判断。

判断先检查危险命令黑名单和基础文件工具的工作区路径，再检查所有匹配规则：`deny` 优先于 `ask`，`ask` 优先于 `allow`。`default` 默认放行只读调用，其他调用需审批；`strict` 不采纳 `allow`，未被拒绝的调用需审批；`bypass` 放行 `ask` 和无规则调用，但不会覆盖 `deny`、黑名单或路径检查。命令与 MCP 不受文件工具路径检查约束，这些机制均不是操作系统沙箱。

聊天中可用 `/permission strict`、`/permission default` 或 `/permission bypass` 切换档位，写入项目的 `permissions.local.yaml`。终端审批可选择一次、会话或永久批准；会话批准保存在当前权限引擎内存中，并非存入会话数据库，切换聊天会话不一定清除它，重建工具系统后消失。永久批准写入项目 `permissions.local.yaml`，使用相应调用值的精确 allow 规则；已有 `deny`、`ask` 和 `strict` 仍按上述优先级生效。`exec` 没有交互审批，仍需审批的调用会被拒绝，已放行的调用仍会执行。
