# MyCode 工具系统 Checklist

> 每项只依据实际命令输出或真实 TUI 观察结果勾选。自动测试使用临时工作区、模拟 Provider 流和临时 SQLite；真实模型条目必须在 Windows Terminal 中实际执行，不能用单元测试替代。

## 功能验收

- [x] **AC1 — 三协议统一工具清单：** 运行 `npx vitest run tests/unit/tools/registry.test.ts tests/integration/provider-tool-streaming.test.ts`；期望 Anthropic、OpenAI Responses 和 OpenAI Chat 收到名称、描述、Schema 与顺序一致的六个工具，新增测试工具只登记一次即可被三者获取。
- [x] **AC2 — 读取 UTF-8 与边界拒绝：** 运行 `npx vitest run tests/unit/tools/read-file.test.ts tests/unit/tools/workspace-paths.test.ts tests/unit/tools/utf8.test.ts`；期望中文和代码内容完整返回，不存在、二进制、无效 UTF-8、绝对路径、路径穿越及外部链接均返回可区分错误且不泄漏内容。
- [x] **AC3 — 创建文件逐项授权且不覆盖：** 运行 `npx vitest run tests/unit/tools/write-file.test.ts tests/unit/tools/batch-coordinator.test.ts`；期望批准后创建正确内容，拒绝后目标不存在，已存在目标保持原样，失败不留下残缺文件。
- [x] **AC4 — 修改文件唯一匹配：** 运行 `npx vitest run tests/unit/tools/edit-file.test.ts tests/unit/tools/batch-coordinator.test.ts`；期望恰好一处时只替换该处，零匹配、多匹配、二进制、越界、拒绝及提交失败均不改变原文件。
- [x] **AC5 — 命令风险、cwd 与结果：** 运行 `npx vitest run tests/unit/tools/run-command.test.ts tests/unit/tools/approval-coordinator.test.ts tests/tui/chat-screen.test.tsx`；期望审批显示原始命令和网络/子进程/工作区外风险，批准后从工作区启动并返回退出码/stdout/stderr，拒绝后不启动。
- [x] **AC6 — glob 查找文件：** 运行 `npx vitest run tests/unit/tools/find-files.test.ts`；期望嵌套及 Unicode 路径匹配准确、无匹配返回空数组、结果只包含工作区普通文件。
- [x] **AC7 — 普通文本内容搜索：** 运行 `npx vitest run tests/unit/tools/search-text.test.ts`；期望普通文本和代码片段返回准确的一基行列与匹配行，二进制、无效 UTF-8、不可读和工作区外文件不作为文本结果返回。
- [x] **AC8 — 逐项与部分授权：** 运行 `npx vitest run tests/unit/tools/approval-coordinator.test.ts tests/unit/tools/batch-coordinator.test.ts tests/integration/tool-turn.test.ts`；期望同批副作用逐项决定，仅批准项产生副作用，拒绝项有独立结果且全部结果共同回灌。
- [x] **AC9 — 三协议流式 JSON 参数拼接：** 运行 `npx vitest run tests/unit/tools/call-assembler.test.ts tests/integration/provider-tool-streaming.test.ts`；期望多个交错调用按稳定标识完整拼接，损坏 JSON、缺片、冲突标识和无效参数不审批、不执行并形成结构化错误。
- [x] **AC10 — 只读并行与副作用串行：** 运行 `npx vitest run tests/unit/tools/batch-coordinator.test.ts tests/integration/tool-turn.test.ts`；期望只读执行时间重叠，创建/修改/命令严格按模型 position 串行，一项失败不阻断其他调用，结果仍按原顺序排列。
- [x] **AC11 — 整批一次回灌：** 运行 `npx vitest run tests/unit/chat/turn-orchestrator.test.ts tests/integration/tool-turn.test.ts`；期望成功、失败、拒绝和超时按调用 ID 一次加入上下文，模型第二次请求能引用全部结果并生成最终文本。
- [x] **AC12 — 阻止第二批工具：** 运行 `npx vitest run tests/unit/chat/turn-orchestrator.test.ts tests/integration/tool-turn.test.ts tests/tui/tool-components.test.tsx`；期望 final 阶段的新调用保存为 `skipped/agent_loop_limit`，不审批、不执行、不发第三次请求，界面显示达到限制。
- [x] **AC13 — 固定超时不可覆盖：** 运行 `npx vitest run tests/unit/tools/executor.test.ts tests/unit/tools/run-command.test.ts tests/integration/tool-turn.test.ts`；期望慢调用被停止并标为 timeout，模型参数不能延长上限，其他调用和会话继续可用。
- [x] **AC14 — 大结果有界截断：** 运行 `npx vitest run tests/unit/tools/limits.test.ts tests/unit/tools/read-file.test.ts tests/unit/tools/find-files.test.ts tests/unit/tools/search-text.test.ts tests/unit/tools/run-command.test.ts`；期望文本/stdout/stderr 各不超过 64 KiB、匹配不超过 500，并报告原始规模、返回规模和截断状态。
- [x] **AC15 — 结构化错误与隔离：** 运行 `npx vitest run tests/unit/tools tests/integration/tool-turn.test.ts`；期望参数、路径、权限、冲突、非唯一匹配、非零退出、超时及内部异常均可区分，单项失败不退出应用、不丢其他结果。
- [x] **AC16 — TUI 工具状态可观察：** 运行 `npx vitest run tests/tui/tool-components.test.tsx tests/tui/chat-screen.test.tsx tests/tui/app.test.tsx`；期望名称、关键参数、审批和执行状态、结果摘要均显示，等待/批准/拒绝/运行/成功/失败/超时/中断/跳过可区分。
- [x] **AC17 — 工具历史持久化恢复：** 运行 `npx vitest run tests/integration/tool-persistence.test.ts tests/unit/chat/context.test.ts tests/integration/chat-controller.test.ts`；期望重启后调用参数、决定、状态和结果仍可见，后续模型上下文能引用恢复记录。
- [x] **AC18 — 三协议完整流程一致：** 运行 `npx vitest run tests/integration/provider-tool-streaming.test.ts tests/integration/tool-turn.test.ts`；期望三种协议除原始格式外，在定义、调用、结果、审批、顺序、错误和两阶段请求上具有同一统一语义。
- [x] **AC19 — 边界与文件原子性：** 运行 `npx vitest run tests/unit/tools/workspace-paths.test.ts tests/unit/tools/write-file.test.ts tests/unit/tools/edit-file.test.ts`；期望穿越和链接逃逸均失败，拒绝、重复匹配、权限错误和模拟写入/替换失败后无新目录、残缺文件或部分修改。
- [x] **AC20 — TUI 响应与资源有界：** 运行 `npx vitest run tests/unit/tools/limits.test.ts tests/unit/tools/run-command.test.ts tests/unit/tools/search-text.test.ts tests/tui/chat-screen.test.tsx`；期望持续输出和大搜索受限，审批、取消和状态更新仍能处理，测试进程内存不会随输出规模线性保留完整内容。
- [x] **AC21 — 密钥安全与中断恢复：** 运行 `npx vitest run tests/integration/tool-persistence.test.ts tests/integration/tool-turn.test.ts tests/unit/config/secrets.test.ts`，随后运行 `rg -n "sk-[A-Za-z0-9_-]{16,}" src tests README.md Project_Guide/s02.md`；期望测试证明拒绝不执行、非终态恢复为 interrupted、不自动重试，扫描无真实密钥命中。环境变量名称及 README 占位示例不视为密钥。
- [x] **AC22 — 无外网可测试与扩展：** 清空供应商密钥环境变量后运行 `npm test`；期望六工具、注册、审批、调度、回灌和三协议模拟测试全部通过，不请求外网或真实用户文件。
- [x] **AC23 — 稳定调用追踪：** 运行 `npx vitest run tests/unit/tools/call-assembler.test.ts tests/integration/tool-persistence.test.ts tests/integration/tool-turn.test.ts`；期望同批多个同名调用仍可通过内部 ID 和供应商 ID 分别关联参数、审批、结果与错误。
- [x] **AC24 — s01 普通聊天回归：** 运行 `npx vitest run tests/unit/providers tests/unit/chat tests/integration/provider-streaming.test.ts tests/integration/chat-controller.test.ts tests/tui`；期望无工具时仍只发一次请求，普通流式文本、Anthropic thinking、取消、会话切换和历史恢复保持通过。
- [x] **AC25 — 完整有限 Agent 场景：** 运行 `npx vitest run tests/integration/tool-turn.test.ts`；期望在隔离工作区内完成检查、创建、修改、命令验证、逐项审批、一次回灌和最终总结，重启后记录可见且没有执行第二批工具。

## 架构与集成

- [x] **工具定义单一来源：** 运行 `npx vitest run tests/unit/tools/registry.test.ts tests/integration/provider-tool-streaming.test.ts`；期望三个 Provider 的工具列表均由同一注册集合产生，Provider 文件中没有独立维护六工具清单。
- [x] **工具实现与供应商解耦：** 运行 `rg -n -F -e "@anthropic-ai" -e "from 'openai'" -e 'from "openai"' src/tools`；期望无命中。
- [x] **SQLite 边界未泄漏：** 运行 `rg -n "node:sqlite" src --glob "!src/storage/worker.ts"`；期望无命中，工具与编排模块只依赖仓储接口。
- [x] **首轮终结与批次原子保存：** 运行 `npx vitest run tests/unit/storage/repository.test.ts tests/integration/tool-persistence.test.ts`；期望模拟事务失败时首轮助手和工具批次均未部分提交。
- [x] **审批决定先于副作用：** 运行 `npx vitest run tests/unit/tools/batch-coordinator.test.ts tests/integration/tool-turn.test.ts`；期望审批持久化失败时对应写入、修改或命令不启动。
- [x] **Responses 工具状态去重：** 运行 `npx vitest run tests/unit/providers/openai-responses.test.ts tests/unit/chat/context.test.ts`；期望 reasoning/非工具 state 可重放，function call 只由统一工具记录表达一次。
- [x] **恢复状态闭合：** 运行 `npx vitest run tests/integration/tool-persistence.test.ts`；期望重启后不存在 pending、approved、queued 或 running，只有真实终态或 interrupted。
- [x] **公开接口存在真实调用方：** 运行 `npm run typecheck && npm test`；期望构建和测试均通过，不存在为满足文档而创建但未接入的核心工具、审批、编排或仓储接口。
- [x] **依赖方向无反转：** 运行 `rg -n "from .*tui|from .*providers|from .*storage" src/tools/implementations src/tools/registry.ts src/tools/executor.ts`；期望六工具和注册/执行基础层不依赖 TUI、Provider SDK 或 SQLite 实现。
- [x] **固定限制不可配置：** 运行 `rg -n "fileTimeoutMs|searchTimeoutMs|commandTimeoutMs|maxTextBytes|maxStdoutBytes|maxStderrBytes|maxMatches" src/config examples`；期望配置 Schema 和示例中无工具限制字段；运行工具参数测试，期望额外限制字段被拒绝。

## 编译、测试与静态检查

- [x] **类型检查：** 运行 `npm run typecheck`；期望退出码 0。
- [x] **Lint：** 运行 `npm run lint`；期望退出码 0 且不新增规则禁用来掩盖错误。
- [x] **全量测试：** 运行 `npm test`；期望退出码 0，全部单元、集成和 TUI 测试通过。
- [x] **覆盖率运行：** 运行 `npm run test:coverage`；期望退出码 0 并生成覆盖报告，工具执行、审批、调度和三协议分支均有覆盖数据。
- [x] **生产构建：** 运行 `npm run build`；期望退出码 0。
- [x] **综合质量门：** 运行 `npm run check`；期望 typecheck、lint、test 和 build 全部退出码 0。
- [x] **CLI 启动：** 运行 `node dist/bin/mycode.js --help`；期望退出码 0、帮助文本正常且不初始化模型请求或执行工具。
- [x] **状态注释留痕：** 运行 `rg -n "\[s02\]|\[s01 旧实现，s02 替换\]" src Project_Guide/s02.md` 并抽查修改文件；期望新增解释性注释使用 s02，替换的 s01 手写实现按项目规则就近保留。
- [x] **范围扫描：** 运行 `rg -n "MCP|base64|image_url|audio|delete_file|move_file|copy_file|rename_file|always allow|自动批准" src`；期望没有本阶段排除功能的实际实现；文案提及风险或“不支持”不算越界。
- [x] **文档一致：** 运行 `rg -n "s02|read_file|write_file|edit_file|run_command|find_files|search_text|Agent Loop|工作区|批准|拒绝" AGENT.md README.md Project_Guide/s02.md`；期望当前状态、六工具、安全边界和有限回灌均有一致说明。

## Windows Terminal 人工端到端

- [ ] **真实 Anthropic 流程：** 在临时项目目录运行 `MyCode --profile <anthropic-profile>`，要求模型读取一个文本文件、创建一个新文件、唯一替换一个现有文件并运行验证命令；逐项批准副作用。期望工具参数流式出现、风险提示完整、文件和命令结果正确、只回灌一次并生成最终总结。
- [ ] **真实 OpenAI Responses 流程：** 在同类临时项目目录运行 `MyCode --profile <responses-profile>` 并执行同一任务；期望与 Anthropic 相同的审批、状态、执行和最终回复行为，退出重启后工具历史仍可见且无重复 function call。
- [ ] **真实 OpenAI Chat 流程：** 在同类临时项目目录运行 `MyCode --profile <chat-profile>` 并执行同一任务；期望多个 `tool_calls` 能正确关联，审批与执行行为与另两协议一致。
- [ ] **部分拒绝流程：** 让模型同批提出创建文件、修改文件和命令，批准创建、拒绝修改、批准命令；期望只有获批操作发生，最终回复能准确说明拒绝项且后续仍可聊天。
- [ ] **命令风险与取消：** 让模型提出持续运行的 PowerShell 命令；确认面板必须显示网络/子进程/工作区外风险。批准后按 `Ctrl+C`，期望进程树停止、调用标为 interrupted、已完成工具结果保留且本轮不回灌。
- [ ] **第二批阻止：** 在真实会话发送一个会在看到工具结果后再次请求工具的测试提示；观察第二批不进入审批、不产生副作用，TUI 显示达到本轮限制并允许发送下一条消息。
- [ ] **工作区边界：** 让模型尝试读取 `..`、绝对路径和指向工作区外的链接；期望均被拒绝。随后批准一个明确访问外部位置的 PowerShell 命令，期望审批提示说明风险，并承认命令不受文件工具边界约束。
- [ ] **二进制与大输出：** 让模型读取图片并运行产生超过 64 KiB 输出的命令；期望图片得到二进制不支持错误，命令输出被截断并显示原始规模，TUI 保持可操作。
- [ ] **中断恢复：** 在等待审批或命令执行时强制关闭 MyCode，再重启同一 profile；观察未完成调用显示 interrupted、不自动执行或重试，已完成记录保持不变。
- [ ] **普通聊天回归：** 对三种 profile 分别发送不需要工具的普通问题，并对 Anthropic 开启 thinking；期望正常流式文本、thinking 展开/折叠、取消、会话切换和退出行为与 s01 一致。

## 验收报告

### 通过（自动证据 45 项）

- 2026-08-19：`npm run check` 退出码 0；typecheck、lint、40 个测试文件/125 项测试和生产构建全部通过。
- 2026-08-19：清空 `ANTHROPIC_API_KEY` 与 `OPENAI_API_KEY` 后运行 `npm test`，40 个测试文件/125 项测试全部通过，无外网依赖。
- 2026-08-19：`npm run test:coverage -- --configLoader runner` 退出码 0；语句覆盖率 67.53%，分支 60.99%，函数 66.54%，行 68.13%；工具域语句 95.18%、行 100%。
- 2026-08-19：`node dist/bin/mycode.js --help` 退出码 0并显示帮助。
- 2026-08-19：自动测试覆盖六工具单一注册、UTF-8/工作区边界、原子文件操作、固定限制、流式调用组装、逐项审批、并发/串行调度、两阶段回灌、第二批阻止、三协议格式、TUI 键盘交互及 s01 回归。
- 2026-08-19：首段 assistant 与工具批次事务回滚、continuation 分段、重启/切换恢复、非终态 interrupted 闭合及恢复后的三协议工具上下文均有自动回归证据。
- 2026-08-19：密钥、Provider/SQLite/TUI 依赖方向、固定限制配置、排除功能范围、状态注释与文档一致性扫描均符合预期。

### 未通过

- 10 项真实 Windows Terminal 人工端到端场景尚未执行；自动测试不能替代真实 Provider、终端进程树、强制关闭恢复及人工可观察性验收。

### 端到端

- 尚未执行；真实三协议与边界场景必须保留实际结果。

