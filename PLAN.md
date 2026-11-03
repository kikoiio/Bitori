# Bitori 项目级待办执行计划

更新时间：2026-11-03
基线：`master`，`a354503bc75633091943b0818abe47beb7d25d8e`。产品实现提交：`507d3d3e1def769d647a957e3f54a42e18dd7229`；三平台 Check 已通过，Linux 桌面最终验收与本计划文档提交后的 Check 尚待完成。

## 当前优先级（用户最新决定）

用户明确要求“先暂停 RSI，完成产品本身先”。RSI 现暂停，历史 smoke 报告保留；不启动新的 RSI、候选生成或基准扩跑。当前主线转为既有产品范围的首次配置、TUI/桌面对话、工具审批、会话保存和终端光标验收。用户已明确将多模态、会话导入与自动断点续跑三项全部纳入本轮；首版已确认并直接进入开发：本地图片、Bitori JSON 导入/导出、检查点续跑且不确定副作用先确认。云同步继续取消。

本轮并行：图片/provider、会话归档、恢复逻辑、TUI、桌面和文档分属独立文件边界。主执行者集成存储、处理交叉审查问题、更新计划并统一验证。重型构建、全量测试、桌面 GUI 和打包放在 GitHub Actions。

## 完成条件

本轮产品工作完成条件：图片从 TUI/桌面入口进入存储和有图片能力的 Provider；不支持图片的协议明确报错且不降级重发；版本化 JSON 可从 CLI/TUI/桌面导出与导入，导入事务失败不留下半个会话；断点续跑使用持久检查点、遵守累计预算，已完成工具不重复执行，不确定的写入/命令先确认；首次使用与功能边界写入文档；相关回归、三平台 Check、Linux 桌面 smoke/打包通过。最后提交并推送 master，确认远端与本地只有 master 且 SHA 相同。

## 工作规模与严谨度

历史记录仍包括桌面和 Provider 验收、四种 Provider 协议、SWE-bench Lite 23 题、五项已接受的安全残留风险、RSI smoke，以及桌面临时审批范围缺陷。本轮 RSI 不运行；SWE-bench、更多真实 Provider 端点、Windows/macOS 桌面和真实终端视觉检查不属于当前已确认的产品功能范围，分别保留在待决/受限状态中。

## 吞吐安排

- **并行工作。** 图片/provider、会话交换、恢复、TUI、桌面和文档按不重叠路径推进；主执行者负责存储 worker、事务、trace 脱敏和跨切片集成。
- **资源安排。** 本机只运行定向单测、TUI 测试、类型检查和静态语法检查；GitHub Actions 承担完整三平台 Check、Electron GUI、打包与构件启动。
- **外部验证。** 用户已授权本轮免费 GitHub Actions 工作流。模型/RSI 实验保持暂停；不把历史单端点 E2E 当作本轮多模态 Provider 的实时端点验收。

## 本轮产品工作清单

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

## 当前证据

- GitHub 当前没有开放 issue 或 PR。仓库没有 TODO 或 roadmap 文件；代码搜索只在一个测试样例中找到字面量 `TODO`。
- 初始基线的 GitHub `Check` 曾在 Ubuntu、Windows 和 macOS 通过：[run 41629488646](https://github.com/kikoiio/Bitori/actions/runs/41629488646)。光标测试修正后的提交 `7bca1f1` 也由三平台 Check 验证通过；当前提交 `1eb870f` 的 Check 已全部通过，见 run 41644656315。
- 本轮提交 `7d58863` 的首轮 `Check` 为 [run 41636113358](https://github.com/kikoiio/Bitori/actions/runs/41636113358)：Ubuntu 与 macOS 通过；Windows 的快速流式光标稳定性测试在 20 秒截止时仍处于 streaming。后续提交将测试改为等待 `sendMessage` 自然结束，复验通过。
- 首轮 Linux 桌面验收 [run 41636209387](https://github.com/kikoiio/Bitori/actions/runs/41636209387) 的 AppImage 步骤失败：Playwright 会在传入参数前加调试参数，使 `--appimage-extract-and-run` 不再是首参数。后续改用 AppImage 官方支持的 `APPIMAGE_EXTRACT_AND_RUN=1` 环境变量，完整复验通过。
- 修复后提交 `7bca1f1b9682729c7f3197ef1e4cbdf258fa01e4` 的三平台 `Check` 全部通过：[run 41636966238](https://github.com/kikoiio/Bitori/actions/runs/41636966238)。Linux desktop [run 41637023628](https://github.com/kikoiio/Bitori/actions/runs/41637023628) 的开发版、审批 smoke、打包、`linux-unpacked`、AppImage 和解包 deb 启动均通过；只读 artifact 查询确认 `desktop-packaged-linux` 与 `desktop-screenshots` 已上传，均保留至 2026-11-10。
- 最近一次历史 `E2E LLM` 成功运行使用提交 `efa1b8e4f7afa79fe4a8aced94c3002950694f99`，早于本轮提交。六份已跟踪证据覆盖 Qoder、OpenAI Chat 和 Anthropic；OpenAI Responses 没有真实端点证据。证据文件没有运行时 HEAD SHA，无法仅凭文件确认它们测试的确切提交。
- 用户指出 GitHub 已配置模型并授权调用。`E2E LLM` 在提交 `1cfbed5feaf30cf368e8694314f0b33805c3ba41` 自动识别 Anthropic 协议和模型 `DeepSeek-V4.1-Flash-1017-Event`；[run 41638870512](https://github.com/kikoiio/Bitori/actions/runs/41638870512) 通过，5 次迭代、309 输出 token、任务产物校验通过、事后阈值未超额。对应 artifact `e2e-evidence-auto`（604 字节）已核实上传，保留至 2026-11-10；JSON 确认 `workingTreeClean: true` 和完整 commit SHA。当前 GitHub 只配置这一组通用 endpoint/key/model，因此不将同一 Anthropic endpoint 冒充成其余三种协议。
- 本计划开始前最近一次 Linux 桌面 smoke 和打包成功记录是 2026-10-28。那次只启动开发入口和 `linux-unpacked`；AppImage 与 deb 只构建并上传，未启动，桌面 smoke 也没有覆盖“本会话”和“永久允许”。当前完整验收已在 run 41637023628 通过。
- 最近一次 SWE-bench Lite 23 题开发集记录为 2026-10-28、agent SHA `ff9a4fb8ea70d9c0a7d2191086af99925a07069d`：23/23 题有结果，但 8 个 `agent_error`、7 个 `unresolved`、8 个 `infrastructure_error`，没有 `resolved`。结果中的问题包括模型工具调用错误、Groq 速率/上下文限制及 gold 环境验证失败；不能当作当前版本验收。
- 提交 `8ac6b32` 上第 0 题在 run [41640309946](https://github.com/kikoiio/Bitori/actions/runs/41640309946)（5 次迭代）与 [41641115352](https://github.com/kikoiio/Bitori/actions/runs/41641115352)（10 次迭代）均以 `agent_error` 结束、补丁为空。轨迹证明初始 Git ownership 报错随后由 Agent 自行加入精确 `safe.directory` 配置并恢复；不能将它当作持续根因。第二次轨迹还显示 Agent shell 的 `python` 是系统 3.11.5，复现代码因 `collections.Mapping` 失败；gold grader 使用镜像内 `/opt/miniconda3/envs/testbed/bin/python`。随后为 Agent shell 统一 testbed `PATH`，并修正合法 U+FFFD 字符被误判为轨迹截断及固定写死“20 次”的迭代上限错误提示。补丁和 9 项 Python runner 测试、17 项 AgentRunner 测试已通过；提交 `1eb870f` 的 Check 已由 run 41644656315 全平台通过。单题复验将在最终文档/证据提交的 Check 通过后派发。
- TUI 的模拟终端测试覆盖光标行列、中文折行、输入、排队和取消，且已由修复后提交 `7bca1f1` 的三平台 `Check` 运行并通过。它没有启动 CLI 做真实终端交互验收。
- 本轮产品实现提交 `507d3d3e1def769d647a957e3f54a42e18dd7229` 的三平台 `Check` [run 41669917762](https://github.com/kikoiio/Bitori/actions/runs/41669917762) 全部通过。Ubuntu 完成类型检查、lint、构建及 111 个测试文件的 737 项测试；Windows 和 macOS 的完整 `npm run check` 也通过。此前该集成检查发现控制器将带本地 checkpoint 的会话直接送入严格归档 schema，已修复为经过版本化归档白名单规范化；回归与存储 worker 集成测试通过。
- 最终文档提交 `6a56090ce8541e5b9cbee92f2a3f3bb514c2f5a4` 的三平台 `Check` [run 41670936682](https://github.com/kikoiio/Bitori/actions/runs/41670936682) 全部通过。Linux desktop [run 41670975726](https://github.com/kikoiio/Bitori/actions/runs/41670975726) 在首个桌面 smoke 发现 Electron 45 移除了旧 `clipboard.readImage/writeImage` API；已改为异步 ClipboardItem 接口。[后续复验 run 41671689523](https://github.com/kikoiio/Bitori/actions/runs/41671689523) 确认 smoke 主进程 evaluator 不提供 `require`，故测试改用 Node/Web 标准全局 API 创建 ClipboardItem 图片；此修正的桌面 smoke 仍待复验。
- [再一次桌面复验 run 41672493312](https://github.com/kikoiio/Bitori/actions/runs/41672493312) 已运行到剪贴板粘贴预览，并确认功能显示名为 `clipboard.png`；测试误将它与文件选择入口的 `icon.png` 等同。现已修正该断言，桌面/打包完整复验待运行。
- [桌面复验 run 41672961793](https://github.com/kikoiio/Bitori/actions/runs/41672961793) 已通过剪贴板写入/读取、图片发送和导出，失败在导入验证唯一选择器匹配两条图片消息。改为精确等待两张导入图片后重跑。
- [桌面复验 run 41673485851](https://github.com/kikoiio/Bitori/actions/runs/41673485851) 已通过图片粘贴、纯图片发送、图片导出/导入和两条附件恢复；后续模型 smoke 的 Provider fixture 未列出配置默认模型 `test-model`，按实现预期没有显示不可用默认模型的选择项。现将默认模型加入可用列表，重跑余下审批和打包验收。
- 桌面权限引擎此前把“本会话允许”加入工作区运行时共享规则，没有按对话 `sessionId` 隔离；这会让另一个聊天复用临时授权。当前实现改为会话 ID 作用域，引擎与 AgentRunner 回归测试通过，桌面跨会话审批 smoke 也在 run 41637023628 通过。
- 用户于 2026-11-03 取消云同步；决定见 [ADR 0001](docs/decisions/0001-cloud-sync-out-of-scope.md)。多模态、会话导入和自动断点续跑已纳入当前首版范围，具体状态见下表。
- 用户于 2026-11-03 接受安全文档列出的五项当前残留风险；决定见 [ADR 0002](docs/decisions/0002-accept-current-security-residual-risks.md)。
- RSI 历史 run 41647782174 在 preflight 因依赖快照拒绝 `node_modules/.bin` 安全相对符号链接而中断；artifact 确认 0 请求、0 tokens。`tree_digest` 随后记录目录、文件模式/内容和链接目标，仅接受严格解析在依赖根目录内的链接，并在目录扫描失败时中止；14 项 sandbox 测试通过。后续 RSI 实验也已结束并记录，用户现已要求暂停，不启动新实验。
- Anthropic SDK 在自定义 base URL 后请求 `/v1/messages`；RSI gateway 归一化原本会丢失自定义 `/anthropic` 前缀的 `/v1`。现已在 `upstream_base` 为该协议补齐版本段，并由测试覆盖根地址、自定义前缀和完整 endpoint 地址。
- 本机 `/usr/bin/x-terminal-emulator` 指向 Ptyxis。新窗口成功显示 Bitori TUI 的可访问树；Orca Linux provider 报告截图能力不支持，且启动时出现已有本地会话文本。为避免更改该会话，没有输入；真实光标视觉验收为 `INCONCLUSIVE`。

## 并行安排

本轮已完成的并行切片分别包括 TUI、桌面、Provider/图片、会话交换、恢复和文档。主执行者审阅并整合存储 worker、计划/索引、trace 脱敏、归档事务和跨层验证。重型验证统一由 GitHub Actions 运行，不在本机并行启动。

## 待办状态

| 项目 | 当前状态 | 完成证据或门槛 |
|---|---|---|
| 当前三平台代码检查 | 已通过 | 提交 `507d3d3e1def769d647a957e3f54a42e18dd7229`；[run 41669917762](https://github.com/kikoiio/Bitori/actions/runs/41669917762) Ubuntu/Windows/macOS 全通过；Ubuntu 111 files、737 tests |
| Linux 桌面 GUI/打包 | 待运行 | 用户已授权免费 GitHub Actions；运行 `Linux desktop`，核对开发/打包 smoke、AppImage/deb 启动及截图 artifact |
| 本机定向检查 | 已验证 | `npm run typecheck` 通过；18 个定向 Vitest 文件共 193 项通过；改动 TS/TSX 文件 ESLint、桌面 JS `node --check` 与 `git diff --check` 通过 |
| 多模态 | 实现及跨平台 Check 通过；桌面验收待运行 | 本地 PNG/JPEG/GIF/WebP，单图 4 MiB、最多 4 张且合计 8 MiB；桌面选图/粘贴、终端 `/attach`；四种 Provider adapter 离线测试通过。真实图片端点验收不在本轮，Linux 桌面 smoke 待运行 |
| 会话导入/导出 | 实现、三平台和 SQLite 集成通过；桌面验收待运行 | 版本 1 自包含 JSON；消息、工具记录、图片，排除凭据/provider state；CLI 与 TUI/桌面入口；导入重映射 ID 且数据库事务保护。控制器直接导入也会按便携归档规范化 |
| 自动断点续跑 | 实现、存储集成与三平台 Check 通过；桌面验收待运行 | 恢复沿用 run 和检查点，保留已完成工具结果且不直接重放；不确定写入/命令要求显式确认；未落盘完成的轮次重试同一轮，已落盘最终回答不再次请求模型；预算与 SQLite 恢复测试由 Check 通过 |
| TUI 缺陷与产品入口 | 已实现，三平台全量 Check 通过 | 会话草稿隔离、过渡期排队、附件/归档/恢复入口；Check 含光标/输入行为测试。真实 Ptyxis 光标视觉验收仍为 `INCONCLUSIVE` |
| 桌面缺陷与产品入口 | 已实现，Linux 桌面云端验收待运行 | 默认模型恢复、重命名草稿保留、图片/归档/恢复入口和 smoke 覆盖；本机 `node --check` 通过；GUI/打包只在 GitHub Actions 验证 |
| 首次使用与功能文档 | 已有内容；最终文档 Check 与链接复核待完成 | 根 README、配置/开发参考、架构/意图、评测状态及项目索引已更新；本次同步后再核对链接和云端状态 |
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

## 阶段

1. **完成盘点。** 已汇总三个独立审查与当前项目文档；把实现缺陷、验收缺口、风险处置、产品决定和暂停项目分别记录。
2. **补齐本地可执行实现。** 已按会话 ID 隔离临时授权；桌面 smoke 增加四项审批选择和范围断言；Linux 工作流新增 AppImage/deb 启动；Provider 证据新增提交 SHA 与工作树洁净标记及独立结果目录。定向测试（23 项）、类型检查、改动文件 lint、脚本语法、工作流 YAML 解析、6 份文档本地链接与差异检查均通过。
3. **关闭外部验收。** 先前版本三平台 `Check` 与 Linux desktop workflow 通过，真实 Provider E2E 通过。SWE-bench 单题两次未完成后修正 Agent shell Python 版本与轨迹诊断；最终第 0 题复验仍在 10 轮上限结束、空补丁，原因已记录。RSI 的依赖快照与 Anthropic 网关认证缺陷均已修复，目标网关测试 85 项通过；提交 `a4da145` 的三平台 Check 通过。最终有界 smoke 完成 preflight 与 30 次成功模型请求，但 Agent 达到 30 轮上限，部分补丁未评分，结果 `no_candidate`；完整用量及 artifact 已记录。
4. **处理 TUI 与桌面目标范围。** 模拟光标/输入用例由三平台 Check 通过。Ptyxis 实机检查受 Orca Linux provider 不支持截图及本地已有会话内容影响，未发送输入，真实光标视觉验收记为 `INCONCLUSIVE`。Windows/macOS 桌面支持仍在现有范围之外。
5. **记录安全处置。** 用户接受五项既有残留风险；在安全文档和 ADR 中记录范围与日期，风险事实及现有控制保持可见。
6. **实现产品新增功能。** 三项范围和共享契约已确定；图片/provider、版本化会话交换与事务导入、检查点恢复及 TUI/桌面入口已接入。run 41669917762 的三平台全量检查和 SQLite 集成回归通过；等待 Linux 桌面 GUI/打包及本计划最终提交的 Check。云同步保持取消。
7. **RSI 已暂停（以下保留历史执行记录）。** 用户明确要求继续并授权可用模型；使用已配置的 Anthropic/DeepSeek profile 及 `smoke.json` 的硬预算。第一轮由安全符号链接快照问题在模型调用前中断；第二轮因 Anthropic 认证头不匹配在首请求失败（1 请求、0 tokens、无上游调用）。修正网关协议凭证并由 85 项测试覆盖后，`a4da145` 三平台 Check 通过，第三轮 run 41652747706 正常完成 preflight 和 baseline；网关 30/30 成功，计量 747,715 tokens。Agent 达 30 轮上限并留下部分补丁，但评测器按正常完成规则将其记录为 `agent_error`、不评分，最终 `no_candidate`。artifact 已核实，不自动合并、不重复同条件模型调用。
8. **最终核验。** 每项保留证据或明确的延期理由；更新文档索引；确认测试、工作流、分支和工作区状态，并审阅决策轨迹。

## 已完成的云端验收

- 用户授权使用免费云资源后，将 `master` 推送至提交 `7d58863`，并触发三平台检查；初次运行暴露 Windows 光标稳定性测试的 20 秒截止问题，已在 `7bca1f1` 修复并由 run 41636966238 全平台复验通过。
- 手动运行 Linux desktop workflow，初次 AppImage 测试因 AppImage 参数顺序失败；改用 `APPIMAGE_EXTRACT_AND_RUN=1` 后，run 41637023628 的所有 smoke 通过。`desktop-packaged-linux`（237,007,447 字节）与 `desktop-screenshots`（870,292 字节）已只读核实上传，保留至 2026-11-10。

## 剩余范围与成本边界

- **Provider 覆盖范围。** 当前 Anthropic/DeepSeek 配置已通过一次固定任务；25k token / 1 credit 阈值是运行后检查，不是硬限制。若要验收 Qoder、OpenAI Chat 或 OpenAI Responses，需分别配置正确 endpoint/key，不能把 Anthropic endpoint 直接当作这些协议。
- **SWE-bench Lite 开发集。** 工作流可运行单题，历史计划的下一次第 0 题诊断最多 10 次迭代/600 秒；当前先完成产品主线，未派发新任务。工作流没有总 token/美元硬上限。Docker runner 会下载固定公开数据和镜像，将公开任务发送给 Provider；隔离容器中的 Agent 可访问配置凭据和网络。结果、轨迹、诊断、补丁和汇总 artifact 保留 7 天。完整 23 题集仍未授权。
- **RSI smoke。** 用户授权使用可用模型。实验配置为 Docker、90 分钟、100 次请求、2,000,000 累计 tokens，每次请求最多输出 32,000 tokens。run 41647782174 在 preflight 因依赖树内安全相对链接失败，0 请求；`tree_digest` 修复并通过 14 项 sandbox 测试。run 41650351744 在 Anthropic SDK 的 `x-api-key` 与网关 Bearer 不匹配时以 1 请求、0 tokens、0 上游调用中断；网关已按协议校验临时凭证，目标测试 85 项通过。最终 run 41652747706 完成 preflight/baseline，30 次请求均成功、计量 747,715 tokens；Agent 达迭代上限，提交了部分补丁，但按评测契约未正常完成，因此 `agent_error`、跳过评分、没有 RSI 候选。artifact `rsi-smoke-41652747706`（33,754 bytes）已核实，保留 7 天；不自动合并、不重复同配置调用。额度是实验硬上限，不是价格承诺。
- **产品功能。** 云同步已由用户取消，保持不支持。多模态、会话导入和自动断点续跑已获确认并纳入本轮；当前状态见本计划表格。
- **安全风险处置。** 用户接受 `docs/reference/security.md` 列出的五项当前残留风险：仓库说明/skills/命令进入模型上下文；模型可能诱导用户批准；本地工作区信任清单无密码学保护；bypass 档跳过逐次审批；trace/历史可能包含未知机密。事实和现有控制保留在安全文档，见 ADR 0002。
- **终端与桌面范围。** 已将本机默认终端 Ptyxis 设为真实光标/输入验收目标；实际显示仍未核验。Windows/macOS 桌面支持仍在现有范围之外。

## 验收记录

每个阶段结束时，把真实命令、提交 SHA、工作流链接或文件行号写入 `.audit/bitori-backlog.tsv`。未运行的检查记为 `INCONCLUSIVE`，不得记作通过。

`.audit/` 已由仓库 `.gitignore` 排除。为让项目级执行记录可复核，本轮会将 `.audit/bitori-backlog.tsv` 作为明确文件加入提交；临时 checklist 仍只保存在本地。
