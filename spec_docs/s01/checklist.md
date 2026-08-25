# MyCode Checklist

> 每一项都必须通过运行代码或观察实际行为验证。只有获得实际输出后才能勾选；失败项修复后需重新执行相关检查。

## Spec 验收标准覆盖

- [ ] **AC1 — Windows 全屏启动：** 在 Windows Terminal 的 PowerShell 中运行 `MyCode`；期望进入备用屏幕，并同时看到消息区、输入区和状态区。
- [x] **AC2 — 固定 YAML/.env 加载：** 运行 `npm test -- tests/unit/config`；期望固定 `.mycode` 目录、三个协议、六个 profile 字段和 `${ENV_NAME}` 解析用例全部通过。
- [ ] **AC3 — Profile 选择：** 分别用单 profile、多 profile 和 `MyCode --profile <name>` 启动；期望单 profile 直接进入、多 profile 显示选择页、指定名称直接选中。
- [x] **AC4 — 配置错误：** 运行 `npm test -- tests/unit/config/schema.test.ts tests/unit/config/loader.test.ts tests/unit/config/secrets.test.ts tests/unit/cli/args.test.ts`；期望缺失文件/字段/变量、重复名称、未知 profile 和非法 thinking 均阻止请求，且错误中无密钥。
- [ ] **AC5 — 按 Profile 恢复最近会话：** 运行 `npm test -- tests/unit/storage/repository.test.ts tests/integration/chat-controller.test.ts`；期望两个 profile 各自只恢复自己的最近会话。
- [ ] **AC6 — 新建、列表和切换会话：** 运行 `npm test -- tests/integration/chat-controller.test.ts tests/tui/chat-screen.test.tsx`；期望新建会话、按最近时间列出并切换后显示对应消息。
- [ ] **AC7 — 三协议真实流式行为：** 运行 `npm test -- tests/integration/provider-streaming.test.ts`，随后在 Windows Terminal 分别使用有效 Anthropic、OpenAI Responses、OpenAI Chat 配置请求较长回答；期望三者都在完成前产生多次可见更新并最终得到完整文本。
- [ ] **AC8 — Claude thinking 兼容与展示：** 运行 `npm test -- tests/unit/providers/anthropic.test.ts tests/tui/chat-screen.test.tsx`；期望 adaptive 直接成功、manual-only 在明确 400 后以 `4096/8192` 重试，其他错误不重试，thinking 生成时展开并在完成后折叠。
- [ ] **AC9 — 多轮记忆：** 运行 `npm test -- tests/unit/chat/context.test.ts tests/integration/chat-controller.test.ts`，并在真实会话先提供特定事实、下一轮只询问该事实；期望完整历史按顺序发送且模型能正确引用上一轮。
- [ ] **AC10 — 完整持久化恢复：** 运行 `npm test -- tests/integration/storage-worker.test.ts tests/integration/chat-controller.test.ts`；期望普通回复、thinking、cancelled 状态、usage 和 OpenAI replay state 在关闭并重开数据库后保持一致。
- [ ] **AC11 — 生成中取消：** 运行 `npm test -- tests/integration/chat-controller.test.ts tests/tui/keyboard.test.tsx`；再在真实长回复生成时按 `Ctrl+C`，期望连接停止、部分内容标记 cancelled、界面仍可继续发送。
- [ ] **AC12 — 空闲退出与终端恢复：** 在空闲聊天页按 `Ctrl+C`；期望 MyCode 退出码为 0、恢复原终端内容和光标，重新启动后退出前的消息仍存在。
- [ ] **AC13 — 请求错误隔离：** 运行 `npm test -- tests/integration/provider-streaming.test.ts tests/integration/chat-controller.test.ts`；期望认证、限流、网络断开和供应商错误均显示可理解信息，不损坏历史，并允许发送下一条消息。
- [x] **AC14 — 状态和 token 用量：** 运行 `npm test -- tests/unit/providers tests/tui/app.test.tsx`；期望状态区始终显示 profile、model、请求状态，并在事件提供 usage 时显示输入/输出 token，不提供时不估算。
- [ ] **AC15 — Provider 抽象：** 运行 `npm test -- tests/integration/chat-controller.test.ts`；期望模拟 `LLMClient` 无需 Anthropic/OpenAI SDK 事件即可驱动流式文本、取消、失败和 SQLite 保存。
- [ ] **AC16 — 响应性、缩放和 Unicode：** 运行 `npm test -- tests/tui tests/integration/chat-controller.test.ts`；随后真实生成期间输入文字、调整窗口并粘贴中文与多行代码；期望键盘不冻结、布局不崩溃、内容保存恢复后不损坏。
- [ ] **AC17 — 密钥和网络安全：** 运行 `npm test -- tests/unit/config/secrets.test.ts tests/integration/provider-streaming.test.ts tests/integration/storage-worker.test.ts`；期望 YAML 解析结果之外的输出、错误和 SQLite 不含密钥，测试只观察到选定 Provider 的请求。
- [ ] **AC18 — 强制终止后的数据库可靠性：** 运行 `npm test -- tests/integration/storage-worker.test.ts`；随后在已保存多条消息后强制结束 MyCode 并重启，期望已提交消息可读、数据库能打开、其他会话不受影响。
- [x] **AC19 — 无外网可测试：** 断开真实 API 配置或使用全假密钥运行 `npm run check`；期望配置、Provider、控制器、SQLite 和 TUI 自动测试全部只依赖本地 fixture/server 并通过。
- [ ] **AC20 — 四种收尾路径：** 运行 `npm test -- tests/integration/provider-streaming.test.ts tests/integration/chat-controller.test.ts tests/integration/storage-worker.test.ts tests/tui/keyboard.test.tsx`；期望完成、取消、失败和正常退出均无残留 Worker、server、timer、请求或错误的终端状态。

## 架构与集成

- [x] **统一 Provider 边界：** 运行 `rg -n "from ['\"](?:openai|@anthropic-ai/sdk)['\"]" src/chat src/tui src/storage`；期望无匹配，证明业务、TUI 和存储不直接依赖供应商 SDK。
- [x] **SQLite 隔离：** 运行 `rg -n "node:sqlite" src`；期望运行时代码只在存储 Worker 中导入，主线程模块无直接导入。
- [x] **协议分离：** 运行 `npm test -- tests/unit/providers/factory.test.ts tests/integration/provider-streaming.test.ts`；期望三个 protocol 分别创建独立客户端并输出同一种事件模型。
- [x] **Responses replay：** 运行 `npm test -- tests/unit/providers/openai-responses.test.ts tests/integration/storage-worker.test.ts`；期望完整 output items 按顺序持久化和重放，损坏 state 安全退回普通文本。
- [x] **Thinking 回退边界：** 运行 `npm test -- tests/unit/providers/anthropic.test.ts`；期望只有无任何 delta 的明确 adaptive 不兼容 400 触发一次 manual 回退。
- [ ] **原子 Turn：** 运行 `npm test -- tests/unit/storage/repository.test.ts tests/integration/storage-worker.test.ts`；期望用户消息和 assistant draft 同事务创建，任何模拟失败都不会留下半个 turn。
- [ ] **流式检查点：** 运行 `npm test -- tests/integration/chat-controller.test.ts`；期望 UI 每个 delta 更新、SQLite 写入按 200ms 合并，终止时完整内容覆盖最后检查点。
- [x] **上下文规则：** 运行 `npm test -- tests/unit/chat/context.test.ts`；期望 user、completed、非空 cancelled 被包含，failed 和 thinking 展示文本被排除。
- [ ] **Profile 数据隔离：** 运行 `npm test -- tests/unit/storage/repository.test.ts tests/integration/chat-controller.test.ts`；期望列表、恢复和新建会话都只使用当前 profile。
- [ ] **无并发请求：** 运行 `npm test -- tests/integration/chat-controller.test.ts tests/tui/keyboard.test.tsx`；期望流式期间第二次发送、切换和新建会话都被拒绝且原因可见。
- [x] **无 Agent 功能越界：** 运行 `rg -n "node:child_process|child_process|execFile|execSync|spawnSync|function_call|tool_use|MCP" src`；期望没有命令执行、工具调用或 MCP 实现。

## 编译与自动测试

- [x] **干净安装：** 删除可重新生成的 `node_modules` 后运行 `npm ci`；期望依赖完全按 lockfile 安装并退出码 0。
- [x] **类型检查：** 运行 `npm run typecheck`；期望退出码 0，无 TypeScript 错误。
- [x] **Lint：** 运行 `npm run lint`；期望退出码 0，无 ESLint 或 React Hooks 错误。
- [x] **单元测试：** 运行 `npm test -- tests/unit`；期望全部通过，无跳过的关键需求用例。
- [x] **集成测试：** 运行 `npm test -- tests/integration`；期望 Provider、控制器和 Worker 测试全部通过且无 open-handle 警告。
- [x] **TUI 测试：** 运行 `npm test -- tests/tui`；期望页面、Unicode、resize、焦点和快捷键测试全部通过。
- [x] **覆盖率执行：** 运行 `npm run test:coverage`；期望退出码 0，配置、Provider、控制器和存储均出现在覆盖率报告中。
- [x] **正式构建：** 运行 `npm run build`；期望退出码 0，生成 `dist/bin/mycode.js` 和 `dist/storage/worker.js`。
- [x] **命令帮助：** 运行 `node dist/bin/mycode.js --help`；期望显示用法、退出码 0、不读取密钥、不创建 SQLite。
- [x] **总质量门槛：** 运行 `npm run check`；期望 typecheck、lint、测试和 build 全部通过，最终退出码 0。
- [x] **占位密钥扫描：** 运行 `rg -n --hidden -g '!node_modules/**' -g '!.git/**' -g '!package-lock.json' "sk-[A-Za-z0-9_-]{20,}" .`；期望无真实密钥命中。

## Windows Terminal 端到端场景

- [ ] **完整首次启动流程：** 在固定 `.mycode` 目录配置至少两个 profile，运行 `MyCode`，选择其中一个并发送问题；期望选择页、聊天页、流式回复和状态栏依次正常出现。
- [ ] **三协议流程：** 分别运行 `MyCode --profile <anthropic>`、`MyCode --profile <responses>`、`MyCode --profile <chat>` 并发送较长请求；期望三者在完成前持续更新、完成后可继续下一轮。
- [ ] **Thinking 流程：** 使用支持 thinking 的 Anthropic profile 发起复杂请求；期望 thinking 生成时展开、回答完成后折叠，Tab 切换消息焦点后可用 Enter 再次展开/折叠。
- [ ] **多轮与恢复流程：** 在一轮中告诉模型“验收代号是蓝鲸-47”，下一轮询问代号，空闲退出并重新启动；期望模型回答正确，且重启自动恢复包含两轮内容的最近会话。
- [ ] **会话管理流程：** 按 `Ctrl+N` 新建会话，发送不同内容，再用 `Ctrl+O` 返回旧会话；期望列表排序正确，切换后各会话内容互不混合。
- [ ] **取消后继续流程：** 请求长回答，在至少两个分块出现后按 `Ctrl+C`，再发送新问题；期望部分回复标记 cancelled，新问题正常生成，重启后 cancelled 内容仍可查看。
- [ ] **窗口与粘贴流程：** 将窗口缩到小于 60×16，再恢复尺寸并粘贴包含中文、换行和代码的文本；期望小窗口提示可退出，恢复后布局正常，多行内容完整发送和保存。
- [ ] **供应商错误流程：** 临时使用无效 key、限流模拟端点和中途断开的本地 SSE 端点；期望错误分类可理解、不显示密钥、不退出 TUI，并可继续操作。
- [ ] **终端恢复流程：** 分别从空闲、完成、取消和失败状态退出；期望每次都恢复进入 MyCode 前的终端内容、光标和输入模式。
- [ ] **强制终止流程：** 在已有已提交消息的会话中强制结束进程，再启动相同 profile；期望数据库可打开、已提交消息存在、仅最近 200ms 内未检查点的流片段可能缺失。
- [ ] **固定路径边界：** 从不同工作目录运行同一个 `MyCode --profile <name>`；期望始终使用 `%USERPROFILE%\.mycode` 下同一配置和数据库，不读取当前目录的 YAML/.env。

## 验收报告（2026-08-10）

### 通过（自动化与静态检查：22/53）

- [x] `npm ci`：成功安装 236 个包，审计结果为 0 个已知漏洞。
- [x] `npm run check`：typecheck、lint、20 个测试文件中的 35 个测试、正式构建全部通过。
- [x] `npm run test:coverage`：执行成功；总体行覆盖率 52.68%，本阶段未设置强制覆盖率阈值。
- [x] `node dist/bin/mycode.js --help`：显示用法并退出；`dist/bin/mycode.js` 首行为 Node shebang。
- [x] 架构扫描：供应商 SDK 未越过 Provider 边界；`node:sqlite` 只在 Storage Worker 中导入；源码无命令执行、tool use 或 MCP 实现。
- [x] 安全扫描：源码和示例未命中疑似真实 `sk-...` 密钥；旧 tmux/tool use 约束已移除。

### 尚未通过或未执行

- [ ] Windows Terminal 真实端到端场景尚未执行：当前环境没有用户的三个有效供应商 profile/API Key，也不能代替用户验证真实计费 API。
- [ ] AC7、AC8、AC9、AC11、AC12、AC16、AC18、AC20 中要求的真实供应商、强制终止、窗口交互或终端恢复观察仍需人工验收。
- [ ] 原子失败注入、200ms fake-timer 检查点、并发拒绝和四种收尾路径的专项自动测试仍未达到 checklist 中写明的完整覆盖，因此保持未勾选。
