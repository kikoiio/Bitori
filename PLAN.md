# Bitori 项目级待办执行计划

更新时间：2026-11-04
前一轮产品交付基线：`master`，`8e0281333edd553b0da27dc97bf86cda284e8104`。提交 `f66f293` 的三平台 Check、Linux 桌面/打包验收，以及最终计划/审计提交 `8e02813` 的 [run 41684199794](https://github.com/kikoiio/Bitori/actions/runs/41684199794) 均已通过。本节记录用户随后要求的“整合整个项目除了 RSI 外的所有待办”，不把前一轮的“产品待办完成”误作全项目无待办。

## 当前整合轮次（2026-11-03）

### 目标与完成谓词

范围包括五项此前已接受安全风险的缓解、TUI 光标的真实 PTY 行为验收、当前已配置 Provider 的多模态真实端点验收、状态与文档同步、完整检查及 master 同步。RSI 与 SWE-bench Lite 均归 RSI/评测暂停范围，不运行；Windows/macOS 桌面不在目标内；云同步保持取消。只有用户当前已配置的一组真实模型凭据可用于 Provider 验收，不将它代表成其他协议。

完成谓词：安全文档列出的每项风险都有具体代码控制和回归覆盖，或被明确标为无法消除的剩余风险；TUI 在隔离 PTY 中实际启动并验证光标行为，无法取得像素证据时仍如实标记 `INCONCLUSIVE`；当前 Provider 的图片端点有真实请求证据，或记录其不能支持/不能验证的确切原因；README、架构、配置/安全/开发参考、索引和本计划状态一致；所需 GitHub Actions 检查对最终提交成功；最终本地与远端仅有 `master` 且 SHA 相同。

### 工作规模与并行安排

预计三个代码切片、约 10–20 个源代码/测试文件及 6–8 份状态文档。Trust 清单文件写入与解析、trace 导出处理各由一名 worker 独立负责不重叠路径；主执行者负责项目指令的信任边界、bypass/审批、PTY 验收、Provider 验收与集成。worker 只做定向代码修改，不启动构建、全量测试、GUI 或云端任务。主执行者审阅每个 diff，再按依赖顺序运行定向检查；三平台完整 Check、Provider E2E 以及任何桌面 GUI 均只安排在 GitHub Actions，避免本机争用。

### 阶段与核验

1. **基线与风险归因。** 已读取项目计划、审计记录、代码与验证工作流；从风险控制本身定位修复点。
2. **并行安全修复。** Trust 清单和 trace 导出切片分别实现并加回归；主线处理提示注入、审批及 bypass 风险。
3. **实际产品验收。** 用隔离的真实伪终端进程核对 TUI 光标；用已有 GitHub 配置和受限任务核对 Provider 图片请求。图片验收在 `LLMClient.streamChat` 边界硬限一次调用；该验收禁用 thinking fallback，当前协议 SDK retries 为 0，因此对应一次模型聊天请求。token/credit 阈值仍属于事后报警，不是费用硬上限。
4. **集成与文档。** 逐项审阅 diff，跑相关轻量回归；同步风险处置、剩余限制、验收证据和非目标。
5. **云端验证与同步。** 先跑完整 GitHub Actions Check，必要时运行当前 Provider E2E；结果成功后提交并推送，查询 GitHub 证据、分支和 SHA 进行二次确认。

### 当前轮次清单

- [x] 核实干净的 `master` 基线及 `origin/master`。
- [x] 明确 RSI/SWE-bench、Windows/macOS 桌面及云同步边界。
- [x] 实施并回归验证工作区信任清单文件权限与原子写入。
- [x] 降低 trace/会话导出的机密泄漏风险并覆盖回归。
- [x] 降低项目指令注入、审批诱导及 bypass 档风险；保留不可消除风险说明。
- [x] 对隔离 PTY 中实际运行的 TUI 做 ASCII/CJK 光标行列验收；Ptyxis 像素级外观仍为环境限制。
- [ ] 对唯一已配置 Provider 做图片端点验收；其他协议不冒充覆盖。
- [ ] 同步项目文档、计划表格和审计轨迹。
- [ ] 运行定向检查与 GitHub Actions 完整检查，修复失败并复验。
- [ ] 提交、推送并确认本地和远端只有内容一致的 `master`。

前一轮交付记录如下。

## 前一轮优先级与决策（历史记录）

用户明确要求“先暂停 RSI，完成产品本身先”。RSI 现暂停，历史 smoke 报告保留；不启动新的 RSI、候选生成或基准扩跑。产品范围包括首次配置、TUI/桌面对话、工具审批、会话保存、多模态、会话导入/导出和自动断点续跑；已完成实现、三平台 Check 和 Linux 桌面/打包验收。桌面 caret 回归现通过真实 Chromium/Electron smoke；本机 Ptyxis 像素级光标观感仍为 `INCONCLUSIVE`。云同步继续取消。

本轮并行：图片/provider、会话归档、恢复逻辑、TUI、桌面和文档分属独立文件边界。主执行者集成存储、处理交叉审查问题、更新计划并统一验证。重型构建、全量测试、桌面 GUI 和打包放在 GitHub Actions。

## 前一轮产品完成条件（已达成）

本轮产品工作完成条件：图片从 TUI/桌面入口进入存储和有图片能力的 Provider；不支持图片的协议明确报错且不降级重发；版本化 JSON 可从 CLI/TUI/桌面导出与导入，导入事务失败不留下半个会话；断点续跑使用持久检查点、遵守累计预算，已完成工具不重复执行，不确定的写入/命令先确认；首次使用与功能边界写入文档；相关回归、三平台 Check、Linux 桌面 smoke/打包通过。最后提交并推送 master，确认远端与本地只有 master 且 SHA 相同。

## 前一轮工作规模与边界（历史记录）

历史记录仍包括桌面和 Provider 验收、四种 Provider 协议、SWE-bench Lite 23 题、五项已接受的安全残留风险、RSI smoke，以及桌面临时审批范围缺陷。本轮 RSI 不运行；SWE-bench、更多真实 Provider 端点、Windows/macOS 桌面和真实终端视觉检查不属于当前已确认的产品功能范围，分别保留在待决/受限状态中。

## 前一轮吞吐安排（历史记录）

- **并行工作。** 图片/provider、会话交换、恢复、TUI、桌面和文档按不重叠路径推进；主执行者负责存储 worker、事务、trace 脱敏和跨切片集成。
- **资源安排。** 本机只运行定向单测、TUI 测试、类型检查和静态语法检查；GitHub Actions 承担完整三平台 Check、Electron GUI、打包与构件启动。
- **外部验证。** 用户已授权本轮免费 GitHub Actions 工作流。模型/RSI 实验保持暂停；不把历史单端点 E2E 当作本轮多模态 Provider 的实时端点验收。

## 前一轮产品工作清单（已完成）

- [x] RSI 暂停、云同步取消及本轮功能范围决策已写入计划与意图文档。
- [x] 空统计下 `usage stats --json` 保持合法 JSON，相关 9 项定向测试通过。
- [x] 修复 TUI 会话草稿跨会话污染、发送过渡期丢消息；加入图片/归档/恢复入口与对应测试。
- [x] 修复桌面默认模型恢复及重命名草稿/焦点丢失；加入图片、归档和恢复入口与 smoke。
- [x] 图片附件存储、四种 Provider 请求映射、尺寸/格式限制及 trace 内容脱敏已接入。
- [x] 版本化会话归档、CLI 与 UI 入口、ID 重映射和导入事务已接入。
- [x] 自动断点续跑的存储与运行逻辑、预算累计和崩溃轮次恢复已接入；新构建下 SQLite 集成回归通过。
- [ ] Linux 桌面 GUI/打包验收、最终文档 Check、分支同步与云端证据核对。


### 新功能实现分工

| 负责人 | 文件边界与交付 | 依赖 |
|---|---|---|
| 主执行者 | `src/storage/` 仓储/worker/迁移与导入事务；trace 附件脱敏；计划/文档/集成 | 统一存储协议与附件类型 |
| 图片核心代理 | `src/attachments/`、Provider adapters、有序上下文与图片预算 | ImageAttachment 结构固定 |
| 会话交换代理 | `src/storage/archive.ts`、CLI sessions/args、格式校验回归 | 图片 schema、事务 importConversation |
| 恢复代理 | controller/state、runner、projector、runtime 与 exec 隔离 | claim/checkpoint 仓储接口 |
| TUI 代理 | 聊天页、输入/历史附件展示、导入导出与恢复命令 | controller/附件/归档接口 |
| 桌面代理 | Electron main/preload/renderer、文件与剪贴板入口、smoke | controller/附件/归档接口 |

轻量分析和非冲突编辑并行；存储与共享契约由主执行者整合。代理不运行构建、GUI、全量测试或云端任务；主执行者在定向检查后统一安排 GitHub Actions 全量验证和桌面 smoke。RSI 与基准扩跑不参与本轮验收。

## 前一轮证据（历史记录）

- 本整合轮只读查询 GitHub，开放 issue 与 PR 均为 0。仓库内源码扫描未发现可执行的 TODO/FIXME；命中项仅为 E2E fixture 中名为 `todo.md` 的临时文件及研究文档术语。
- 初始基线的 GitHub `Check` 曾在 Ubuntu、Windows 和 macOS 通过：[run 41629488646](https://github.com/kikoiio/Bitori/actions/runs/41629488646)。光标测试修正后的提交 `7bca1f1` 也由三平台 Check 验证通过；当前提交 `1eb870f` 的 Check 已全部通过，见 run 41644656315。
- 本轮提交 `7d58863` 的首轮 `Check` 为 [run 41636113358](https://github.com/kikoiio/Bitori/actions/runs/41636113358)：Ubuntu 与 macOS 通过；Windows 的快速流式光标稳定性测试在 20 秒截止时仍处于 streaming。后续提交将测试改为等待 `sendMessage` 自然结束，复验通过。
- 首轮 Linux 桌面验收 [run 41636209387](https://github.com/kikoiio/Bitori/actions/runs/41636209387) 的 AppImage 步骤失败：Playwright 会在传入参数前加调试参数，使 `--appimage-extract-and-run` 不再是首参数。后续改用 AppImage 官方支持的 `APPIMAGE_EXTRACT_AND_RUN=1` 环境变量，完整复验通过。
- 修复后提交 `7bca1f1b9682729c7f3197ef1e4cbdf258fa01e4` 的三平台 `Check` 全部通过：[run 41636966238](https://github.com/kikoiio/Bitori/actions/runs/41636966238)。Linux desktop [run 41637023628](https://github.com/kikoiio/Bitori/actions/runs/41637023628) 的开发版、审批 smoke、打包、`linux-unpacked`、AppImage 和解包 deb 启动均通过；只读 artifact 查询确认 `desktop-packaged-linux` 与 `desktop-screenshots` 已上传，均保留至 2026-11-10。
- 最近一次历史 `E2E LLM` 成功运行使用提交 `efa1b8e4f7afa79fe4a8aced94c3002950694f99`，早于本轮提交。六份已跟踪证据覆盖 Qoder、OpenAI Chat 和 Anthropic；OpenAI Responses 没有真实端点证据。证据文件没有运行时 HEAD SHA，无法仅凭文件确认它们测试的确切提交。
- 用户指出 GitHub 已配置模型并授权调用。`E2E LLM` 在提交 `1cfbed5feaf30cf368e8694314f0b33805c3ba41` 自动识别 Anthropic 协议和模型 `DeepSeek-V4.1-Flash-1017-Event`；[run 41638870512](https://github.com/kikoiio/Bitori/actions/runs/41638870512) 通过，5 次迭代、309 输出 token、任务产物校验通过、事后阈值未超额。对应 artifact `e2e-evidence-auto`（604 字节）已核实上传，保留至 2026-11-10；JSON 确认 `workingTreeClean: true` 和完整 commit SHA。当前 GitHub 只配置这一组通用 endpoint/key/model，因此不将同一 Anthropic endpoint 冒充成其余三种协议。
- 本计划开始前最近一次 Linux 桌面 smoke 和打包成功记录是 2026-10-28。那次只启动开发入口和 `linux-unpacked`；AppImage 与 deb 只构建并上传，未启动，桌面 smoke 也没有覆盖“本会话”和“永久允许”。当前完整验收已在 run 41637023628 通过。
- 最近一次 SWE-bench Lite 23 题开发集记录为 2026-10-28、agent SHA `ff9a4fb8ea70d9c0a7d2191086af99925a07069d`：23/23 题有结果，但 8 个 `agent_error`、7 个 `unresolved`、8 个 `infrastructure_error`，没有 `resolved`。结果中的问题包括模型工具调用错误、Groq 速率/上下文限制及 gold 环境验证失败；不能当作当前版本验收。
- 提交 `8ac6b32` 上第 0 题在 run [41640309946](https://github.com/kikoiio/Bitori/actions/runs/41640309946)（5 次迭代）与 [41641115352](https://github.com/kikoiio/Bitori/actions/runs/41641115352)（10 次迭代）均以 `agent_error` 结束、补丁为空。轨迹证明初始 Git ownership 报错随后由 Agent 自行加入精确 `safe.directory` 配置并恢复；不能将它当作持续根因。第二次轨迹还显示 Agent shell 的 `python` 是系统 3.11.5，复现代码因 `collections.Mapping` 失败；gold grader 使用镜像内 `/opt/miniconda3/envs/testbed/bin/python`。随后为 Agent shell 统一 testbed `PATH`，并修正合法 U+FFFD 字符被误判为轨迹截断及固定写死“20 次”的迭代上限错误提示。补丁和 9 项 Python runner 测试、17 项 AgentRunner 测试已通过；提交 `1eb870f` 的 Check 已由 run 41644656315 全平台通过。后续曾计划在最终文档 Check 通过后派发单题复验；该计划因用户将 SWE-bench Lite 划入 RSI 暂停范围而取消，本轮未派发。
- TUI 的模拟终端测试覆盖光标行列、中文折行、输入、排队和取消，且已由修复后提交 `7bca1f1` 的三平台 `Check` 运行并通过。它没有启动 CLI 做真实终端交互验收。
- 本轮产品实现提交 `507d3d3e1def769d647a957e3f54a42e18dd7229` 的三平台 `Check` [run 41669917762](https://github.com/kikoiio/Bitori/actions/runs/41669917762) 全部通过。Ubuntu 完成类型检查、lint、构建及 111 个测试文件的 737 项测试；Windows 和 macOS 的完整 `npm run check` 也通过。此前该集成检查发现控制器将带本地 checkpoint 的会话直接送入严格归档 schema，已修复为经过版本化归档白名单规范化；回归与存储 worker 集成测试通过。
- 最终文档提交 `6a56090ce8541e5b9cbee92f2a3f3bb514c2f5a4` 的三平台 `Check` [run 41670936682](https://github.com/kikoiio/Bitori/actions/runs/41670936682) 全部通过。Linux desktop [run 41670975726](https://github.com/kikoiio/Bitori/actions/runs/41670975726) 在首个桌面 smoke 发现 Electron 45 移除了旧 `clipboard.readImage/writeImage` API；已改为异步 ClipboardItem 接口。[后续复验 run 41671689523](https://github.com/kikoiio/Bitori/actions/runs/41671689523) 确认 smoke 主进程 evaluator 不提供 `require`，故测试改用 Node/Web 标准全局 API 创建 ClipboardItem 图片；当时仍待复验的后续结果与最终修复见下文。
- [再一次桌面复验 run 41672493312](https://github.com/kikoiio/Bitori/actions/runs/41672493312) 已运行到剪贴板粘贴预览，并确认功能显示名为 `clipboard.png`；测试误将它与文件选择入口的 `icon.png` 等同。现已修正该断言，桌面/打包完整复验待运行。
- [桌面复验 run 41672961793](https://github.com/kikoiio/Bitori/actions/runs/41672961793) 已通过剪贴板写入/读取、图片发送和导出，失败在导入验证唯一选择器匹配两条图片消息。改为精确等待两张导入图片后重跑。
- [桌面复验 run 41673485851](https://github.com/kikoiio/Bitori/actions/runs/41673485851) 已通过图片粘贴、纯图片发送、图片导出/导入和两条附件恢复；后续模型 smoke 的 Provider fixture 未列出配置默认模型 `test-model`，按实现预期没有显示不可用默认模型的选择项。现将默认模型加入可用列表，重跑余下审批和打包验收。
- [桌面复验 run 41674058906](https://github.com/kikoiio/Bitori/actions/runs/41674058906) 在补入默认模型的 fixture 后仍未显示回退选项，根因是连接探测只标准化配置模型名、未对比标准化 Provider 返回的 ID；修复双侧规范化并添加单测。同期三平台 run 41674024320 的 Ubuntu 还暴露 `/proc/<pid>/stat` 读取进程刚退出时的 `ESRCH` 竞态，fixture 清理现已按进程不存在处理，完整 Check 待复验。
- 最终代码复验 [run 41674972528](https://github.com/kikoiio/Bitori/actions/runs/41674972528) 已通过图片、归档导入、默认模型回退及 Markdown/链接渲染步骤；原安全断言全局统计 `<img>`，误把当前会话恢复的两张用户附件当成助手 HTML 图片。现改为仅检查助手消息内没有 `<img>`，桌面与打包余下步骤待重跑。
- [桌面复验 run 41675603751](https://github.com/kikoiio/Bitori/actions/runs/41675603751) 已通过图片、归档导入、模型回退、Markdown 安全及首次审批；失败于后续会话切换测试依赖 `.last()` 列表顺序。现保存“你好”所在 session ID 并按 ID 切换，余下 smoke/打包待复跑。
- [桌面复验 run 41676241422](https://github.com/kikoiio/Bitori/actions/runs/41676241422) 已通过 session ID 切换、跨会话审批等前序场景，重命名状态刷新用例报告 caret 变成整段选择 `0–5`。现将焦点与 `1–3` 选区在同一 renderer 操作中设置并先断言前置状态，确认最终光标恢复结果。
- [桌面复验 run 41677114497](https://github.com/kikoiio/Bitori/actions/runs/41677114497) 已确认刷新前选区为 `1–3`，但 renderer 替换输入框后重置成整段 `0–5`。现由输入/selectionchange 记住当前 session 的选区并在 redraw 后恢复，等待桌面验证。
- [桌面复验 run 41677917237](https://github.com/kikoiio/Bitori/actions/runs/41677917237) 证明仅记忆输入/selectionchange 尚未恢复实际 caret，重绘后仍为 `0–5`。现追加 keyup/mouseup 同步，并由 smoke 通过 Home/方向键/Shift+方向键实际设置选区，再触发状态刷新。
- 提交 `14188d1` 的三平台 Check [run 41678421743](https://github.com/kikoiio/Bitori/actions/runs/41678421743) 通过；桌面 run 41678459201 的键盘 smoke 前置实际得到 `5–5`，证明该输入法合成没有建立 `1–3` 选区。切回确定性的选区前置后，提交 `7c0e6bb` 的桌面 run 41679609440 仍观察到 `1–3` 被稍后改成 `0–5`，且输入框节点未替换。
- 查阅 run 41679609440 日志后，根因定位到新建重命名框使用 `setTimeout` 延迟聚焦并全选，异步 `.select()` 会覆盖之后的 caret。提交 `f66f293` 改为插入节点后同步聚焦/全选，并在编辑框仍聚焦时跳过列表重建、复用原节点。
- 提交 `f66f293` 的三平台 `Check` [run 41679968530](https://github.com/kikoiio/Bitori/actions/runs/41679968530) 全部通过。此前 Windows `run-command` Unicode 用例在 10 秒限时内偶发 timeout；对应测试限时调整的提交 `fb6741e` 由 [run 41682368460](https://github.com/kikoiio/Bitori/actions/runs/41682368460) 三平台全部通过。
- 最终计划/审计提交 `69e5c13` 的 [run 41683263653](https://github.com/kikoiio/Bitori/actions/runs/41683263653) 在 Ubuntu、Windows、macOS 均通过。
- Linux desktop [run 41680030634](https://github.com/kikoiio/Bitori/actions/runs/41680030634) 在同一 `f66f293` 上通过开发版 smoke、Linux 打包、打包版启动、AppImage 启动及解包 deb 启动；caret smoke 确认编辑框保持焦点且 `1–3` 选区不变。只读 artifact 查询确认 `desktop-packaged-linux`（236,896,325 bytes）与 `desktop-screenshots`（962,896 bytes）已上传，保留至 2026-11-10。
- 提交 `417bb35f23920c74fa681302c3abb6b2b268f377` 的三平台 Check [run 41676188537](https://github.com/kikoiio/Bitori/actions/runs/41676188537)：Ubuntu 与 macOS 通过；Windows 的 4 个 `run-command` 用例因 timeout 失败，`tool-turn` 临时目录清理另报 `EPERM`。较早 Windows 完整 Check 通过；随当前重命名 smoke 修正提交再复验。
- 当前 caret smoke 提交 `4fb3f07d58241b09b7bce9d245eb59b599c591fa` 的三平台 Check [run 41677079394](https://github.com/kikoiio/Bitori/actions/runs/41677079394) 全部通过。桌面 run 41677114497 则复现并确认 renderer 重绘真实丢选区；已在 `renderer.js` 保存并恢复 caret，待新提交验证。
- 桌面权限引擎此前把“本会话允许”加入工作区运行时共享规则，没有按对话 `sessionId` 隔离；这会让另一个聊天复用临时授权。当前实现改为会话 ID 作用域，引擎与 AgentRunner 回归测试通过，桌面跨会话审批 smoke 也在 run 41637023628 通过。
- 用户于 2026-11-03 取消云同步；决定见 [ADR 0001](docs/decisions/0001-cloud-sync-out-of-scope.md)。多模态、会话导入和自动断点续跑已纳入当前首版范围，具体状态见下表。
- 用户于 2026-11-03 接受安全文档列出的五项当前残留风险；决定见 [ADR 0002](docs/decisions/0002-accept-current-security-residual-risks.md)。
- RSI 历史 run 41647782174 在 preflight 因依赖快照拒绝 `node_modules/.bin` 安全相对符号链接而中断；artifact 确认 0 请求、0 tokens。`tree_digest` 随后记录目录、文件模式/内容和链接目标，仅接受严格解析在依赖根目录内的链接，并在目录扫描失败时中止；14 项 sandbox 测试通过。后续 RSI 实验也已结束并记录，用户现已要求暂停，不启动新实验。
- Anthropic SDK 在自定义 base URL 后请求 `/v1/messages`；RSI gateway 归一化原本会丢失自定义 `/anthropic` 前缀的 `/v1`。现已在 `upstream_base` 为该协议补齐版本段，并由测试覆盖根地址、自定义前缀和完整 endpoint 地址。
- 本机 `/usr/bin/x-terminal-emulator` 指向 Ptyxis。新窗口成功显示 Bitori TUI 的可访问树；Orca Linux provider 报告截图能力不支持，且启动时出现已有本地会话文本。为避免更改该会话，没有输入；真实光标视觉验收为 `INCONCLUSIVE`。

## 前一轮并行安排（历史记录）

本轮已完成的并行切片分别包括 TUI、桌面、Provider/图片、会话交换、恢复和文档。主执行者审阅并整合存储 worker、计划/索引、trace 脱敏、归档事务和跨层验证。重型验证统一由 GitHub Actions 运行，不在本机并行启动。

## 前一轮待办状态（当前整合轮之前）

| 项目 | 前一轮结束时状态 | 该轮证据或门槛 |
|---|---|---|
| 当前三平台代码检查 | 已通过 | 产品提交 `f66f293` 的 [run 41679968530](https://github.com/kikoiio/Bitori/actions/runs/41679968530)、Windows 测试限时修正提交 `fb6741e` 的 [run 41682368460](https://github.com/kikoiio/Bitori/actions/runs/41682368460)，以及最终文档证据提交 `69e5c13` 的 [run 41683263653](https://github.com/kikoiio/Bitori/actions/runs/41683263653) 均在 Ubuntu/Windows/macOS 全通过 |
| Linux 桌面 GUI/打包 | 已通过 | [run 41680030634](https://github.com/kikoiio/Bitori/actions/runs/41680030634) 的开发版、打包版、AppImage、解包 deb smoke 全通过；`desktop-packaged-linux` 236,896,325 bytes 与 `desktop-screenshots` 962,896 bytes 已核实上传，保留至 2026-11-10 |
| 本机定向检查 | 已验证 | caret 修正涉及的 renderer 与 desktop smoke ESLint、Node.js 语法检查、`git diff --check` 通过；重型 build/full tests/GUI 均在 Actions 执行 |
| 多模态 | 实现及验收通过 | 本地 PNG/JPEG/GIF/WebP，单图 4 MiB、最多 4 张且合计 8 MiB；桌面选图/粘贴、终端 `/attach`；四种 Provider adapter 离线测试和 Linux 桌面 smoke 通过。真实图片端点验收不在本轮 |
| 会话导入/导出 | 实现及验收通过 | 版本 1 自包含 JSON；消息、工具记录、图片，排除凭据/provider state；CLI 与 TUI/桌面入口；导入重映射 ID 且数据库事务保护。控制器直接导入也会按便携归档规范化；全量集成和 Linux 桌面 smoke 通过 |
| 自动断点续跑 | 实现及验收通过 | 恢复沿用 run 和检查点，保留已完成工具结果且不直接重放；不确定写入/命令要求显式确认；未落盘完成的轮次重试同一轮，已落盘最终回答不再次请求模型；预算、SQLite 集成和桌面恢复入口通过对应检查 |
| TUI 缺陷与产品入口 | 已实现，三平台全量 Check 通过 | 会话草稿隔离、过渡期排队、附件/归档/恢复入口；Check 含光标/输入行为测试。真实 Ptyxis 光标视觉验收仍为 `INCONCLUSIVE` |
| 桌面缺陷与产品入口 | 已实现，Linux 桌面验收通过 | 默认模型恢复、重命名草稿与 `1–3` 选区在状态更新时保持、图片/归档/恢复入口；开发版、安装包、AppImage、deb smoke 由 run 41680030634 验证 |
| 首次使用与功能文档 | 已同步并通过三平台 Check | README、开发参考、架构/意图、索引及项目待办均更新；最终证据提交 `69e5c13` 由 run 41683263653 全平台验证通过；6 份 Markdown 的本地相对链接目标已核对 |
| 真实终端光标观感 | INCONCLUSIVE | Ptyxis 可访问树可读；Orca Linux provider 不支持截图且启动界面有本地会话文本，因此未输入或确认像素级光标位置。保留既有模拟终端测试结果 |
| 当前配置的真实 Provider | 已有历史验收；本轮不扩展 | Anthropic/DeepSeek 固定任务 309 输出 token，见 run 41638870512；其余三种协议无各自真实端点证据。多模态 Provider 映射由离线协议测试覆盖 |
| SWE-bench Lite 开发集 | 暂缓 | 历史 23 题无 resolved；第 0 题诊断未产出补丁。不是当前产品功能验收，详见 [评测说明](evaluation/README.md) |
| Windows/macOS 桌面支持 | 目标范围之外 | 当前目标为跨平台终端及 Linux 桌面；新增桌面平台需另行决定 |
| 云同步 | 用户取消，保持不支持 | [ADR 0001](docs/decisions/0001-cloud-sync-out-of-scope.md) |
| 仓库说明/skills/命令进入模型上下文 | 用户接受当前风险 | [ADR 0002](docs/decisions/0002-accept-current-security-residual-risks.md)；克隆仓库前仍需审查 |
| 模型诱导用户批准 | 用户接受当前风险 | 审批继续显示真实调用参数，见 ADR 0002 |
| 本地工作区信任清单无密码学保护 | 用户接受当前风险 | 当前为本地文件，路径移动需重新信任，见 ADR 0002 |
| bypass 档跳过逐次审批 | 用户接受当前风险 | 仅在受信环境使用并持续显示提示，见 ADR 0002 |
| trace/历史包含未知机密 | 用户接受当前风险 | 已知配置密钥会脱敏；分享前仍需人工检查未知内容，见 ADR 0002 |
| RSI | 用户明确暂停；产品本身优先 | run 41652747706：网关 30/30 请求成功、计量 747,715 tokens；Agent 达 30 轮上限，部分补丁未评分，最终 `no_candidate`。artifact 已核验；不重复同配置调用 |

## 前一轮阶段记录

1. **完成盘点。** 已汇总三个独立审查与当前项目文档；把实现缺陷、验收缺口、风险处置、产品决定和暂停项目分别记录。
2. **补齐本地可执行实现。** 已按会话 ID 隔离临时授权；桌面 smoke 增加四项审批选择和范围断言；Linux 工作流新增 AppImage/deb 启动；Provider 证据新增提交 SHA 与工作树洁净标记及独立结果目录。定向测试（23 项）、类型检查、改动文件 lint、脚本语法、工作流 YAML 解析、6 份文档本地链接与差异检查均通过。
3. **关闭外部验收。** 先前版本三平台 `Check` 与 Linux desktop workflow 通过，真实 Provider E2E 通过。SWE-bench 单题两次未完成后修正 Agent shell Python 版本与轨迹诊断；最终第 0 题复验仍在 10 轮上限结束、空补丁，原因已记录。RSI 的依赖快照与 Anthropic 网关认证缺陷均已修复，目标网关测试 85 项通过；提交 `a4da145` 的三平台 Check 通过。最终有界 smoke 完成 preflight 与 30 次成功模型请求，但 Agent 达到 30 轮上限，部分补丁未评分，结果 `no_candidate`；完整用量及 artifact 已记录。
4. **处理 TUI 与桌面目标范围。** 模拟光标/输入用例由三平台 Check 通过。Ptyxis 实机检查受 Orca Linux provider 不支持截图及本地已有会话内容影响，未发送输入，真实光标视觉验收记为 `INCONCLUSIVE`。Windows/macOS 桌面支持仍在现有范围之外。
5. **记录安全处置。** 用户接受五项既有残留风险；在安全文档和 ADR 中记录范围与日期，风险事实及现有控制保持可见。
6. **实现产品新增功能。** 三项范围和共享契约已确定；图片/provider、版本化会话交换与事务导入、检查点恢复及 TUI/桌面入口已接入。提交 `f66f293` 的三平台全量检查和 Linux 开发版、AppImage、deb smoke 全部通过，SQLite 集成回归通过。云同步保持取消；文档同步后的 Check 在最终提交后执行。
7. **RSI 已暂停（以下保留历史执行记录）。** 用户明确要求继续并授权可用模型；使用已配置的 Anthropic/DeepSeek profile 及 `smoke.json` 的硬预算。第一轮由安全符号链接快照问题在模型调用前中断；第二轮因 Anthropic 认证头不匹配在首请求失败（1 请求、0 tokens、无上游调用）。修正网关协议凭证并由 85 项测试覆盖后，`a4da145` 三平台 Check 通过，第三轮 run 41652747706 正常完成 preflight 和 baseline；网关 30/30 成功，计量 747,715 tokens。Agent 达 30 轮上限并留下部分补丁，但评测器按正常完成规则将其记录为 `agent_error`、不评分，最终 `no_candidate`。artifact 已核实，不自动合并、不重复同条件模型调用。
8. **最终核验。** 产品代码、Linux 桌面、打包和最终文档提交的三平台 Check 均通过；README、架构、意图、开发说明、计划和审计轨迹已同步。真实终端视觉与真实图片 Provider 端点按范围记录为 `INCONCLUSIVE`/未验；RSI 暂停，云同步取消。最后确认仅有 `master` 且本地/远端 SHA 一致。

## 前一轮已完成的云端验收

- 用户授权使用免费云资源后，将 `master` 推送至提交 `7d58863`，并触发三平台检查；初次运行暴露 Windows 光标稳定性测试的 20 秒截止问题，已在 `7bca1f1` 修复并由 run 41636966238 全平台复验通过。
- 手动运行 Linux desktop workflow，初次 AppImage 测试因 AppImage 参数顺序失败；改用 `APPIMAGE_EXTRACT_AND_RUN=1` 后，run 41637023628 的所有 smoke 通过。`desktop-packaged-linux`（237,007,447 字节）与 `desktop-screenshots`（870,292 字节）已只读核实上传，保留至 2026-11-10。

## 前一轮剩余范围与成本边界（后续调整见本轮状态）

- **Provider 覆盖范围。** 当前 Anthropic/DeepSeek 配置已通过一次固定任务；25k token / 1 credit 阈值是运行后检查，不是硬限制。若要验收 Qoder、OpenAI Chat 或 OpenAI Responses，需分别配置正确 endpoint/key，不能把 Anthropic endpoint 直接当作这些协议。
- **SWE-bench Lite 开发集。** 前一轮曾列出第 0 题诊断（最多 10 次迭代/600 秒），但没有在当前整合轮派发。用户随后明确将 SWE-bench Lite 归入 RSI；本轮与 RSI 一并暂停。该工作流没有总 token/美元硬上限。
- **RSI smoke。** 用户授权使用可用模型。实验配置为 Docker、90 分钟、100 次请求、2,000,000 累计 tokens，每次请求最多输出 32,000 tokens。run 41647782174 在 preflight 因依赖树内安全相对链接失败，0 请求；`tree_digest` 修复并通过 14 项 sandbox 测试。run 41650351744 在 Anthropic SDK 的 `x-api-key` 与网关 Bearer 不匹配时以 1 请求、0 tokens、0 上游调用中断；网关已按协议校验临时凭证，目标测试 85 项通过。最终 run 41652747706 完成 preflight/baseline，30 次请求均成功、计量 747,715 tokens；Agent 达迭代上限，提交了部分补丁，但按评测契约未正常完成，因此 `agent_error`、跳过评分、没有 RSI 候选。artifact `rsi-smoke-41652747706`（33,754 bytes）已核实，保留 7 天；不自动合并、不重复同配置调用。额度是实验硬上限，不是价格承诺。
- **产品功能。** 云同步已由用户取消，保持不支持。多模态、会话导入和自动断点续跑已获确认并纳入本轮；当前状态见本计划表格。
- **安全风险处置。** 用户于 2026-11-03 曾接受当时列出的五项残留风险；本次整合轮已新增项目内容信任门控、审批提示、bypass 二次确认、信任清单保护和导出权限。无法由这些控制消除的部分仍列于安全文档，见 ADR 0002。
- **终端与桌面范围。** 已将本机默认终端 Ptyxis 设为真实光标/输入验收目标；实际显示仍未核验。Windows/macOS 桌面支持仍在现有范围之外。

## 验收记录

每个阶段结束时，把真实命令、提交 SHA、工作流链接或文件行号写入 `.audit/bitori-backlog.tsv`。未运行的检查记为 `INCONCLUSIVE`，不得记作通过。

`.audit/` 已由仓库 `.gitignore` 排除。为让项目级执行记录可复核，本轮会将 `.audit/bitori-backlog.tsv` 作为明确文件加入提交；临时 checklist 仍只保存在本地。
