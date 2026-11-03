# Bitori 项目级待办执行计划

更新时间：2026-11-03
基线：`master`，`e6dc8d5e0a03740b567fafbb1d8841e7bfb2c39c`。工作区在开始时干净。

## 完成条件

项目文档中每项未完成工作都要有可核对的状态和证据。状态只能是已验证、已完成、经用户决定暂缓，或因明确的产品决定和权限等待。未决定的功能不当作已批准需求；RSI 按用户 2026-11-03 的恢复决定进入有界 smoke。

## 工作规模与严谨度

本轮覆盖 3 个只读审查、桌面与 Provider 验收证据、4 种 Provider 协议、SWE-bench Lite 23 题历史未解决结果、4 个产品方向、5 条安全残留风险、RSI smoke，以及桌面“本会话允许”越过对话边界的实现缺陷。用户取消云同步、接受五项安全残留风险、要求继续 RSI，并授权调用任意可用模型。多模态、会话导入和自动断点续跑仍待决定；当前 GitHub 仅配置 Anthropic/DeepSeek 通用 profile。

## 吞吐安排

- **先决步骤。** 汇总只读审查，核对当前状态；任何收费 Provider 请求、云端任务、产品功能实现和安全模型变更都要先过对应门槛。
- **并行工作。** TUI/桌面、Provider、风险/产品/RSI 三个资料审查彼此独立。
- **共享写入。** 主执行者负责 `PLAN.md`、`.audit/`、文档、权限代码和工作流；审查代理只返回报告。汇总后另派一名实现代理只改 Provider 证据脚本，主执行者审查后再扩展其工作目录选项；文件写入不重叠。
- **最小拆分。** 先用 3 个轻量审查代理收集互不重叠的证据；汇总后发现“本会话允许”存在明确越界，作为有文档规格的独立代码切片由主执行者修复。文件写入串行整合；免费云端 GUI 已通过；用户确认可调用 GitHub 已配置模型后，单端点 Provider E2E 已通过，并将 SWE-bench 定为单题诊断。

## 当前证据

- GitHub 当前没有开放 issue 或 PR。仓库没有 TODO 或 roadmap 文件；代码搜索只在一个测试样例中找到字面量 `TODO`。
- 初始基线的 GitHub `Check` 曾在 Ubuntu、Windows 和 macOS 通过：[run 41629488646](https://github.com/kikoiio/Bitori/actions/runs/41629488646)。当前修复后 master 的完整三平台检查也已通过，见下方复验记录。
- 本轮提交 `7d58863` 的首轮 `Check` 为 [run 41636113358](https://github.com/kikoiio/Bitori/actions/runs/41636113358)：Ubuntu 与 macOS 通过；Windows 的快速流式光标稳定性测试在 20 秒截止时仍处于 streaming。后续提交将测试改为等待 `sendMessage` 自然结束，复验通过。
- 首轮 Linux 桌面验收 [run 41636209387](https://github.com/kikoiio/Bitori/actions/runs/41636209387) 的 AppImage 步骤失败：Playwright 会在传入参数前加调试参数，使 `--appimage-extract-and-run` 不再是首参数。后续改用 AppImage 官方支持的 `APPIMAGE_EXTRACT_AND_RUN=1` 环境变量，完整复验通过。
- 修复后提交 `7bca1f1b9682729c7f3197ef1e4cbdf258fa01e4` 的三平台 `Check` 全部通过：[run 41636966238](https://github.com/kikoiio/Bitori/actions/runs/41636966238)。Linux desktop [run 41637023628](https://github.com/kikoiio/Bitori/actions/runs/41637023628) 的开发版、审批 smoke、打包、`linux-unpacked`、AppImage 和解包 deb 启动均通过；只读 artifact 查询确认 `desktop-packaged-linux` 与 `desktop-screenshots` 已上传，均保留至 2026-11-10。
- 最近一次历史 `E2E LLM` 成功运行使用提交 `efa1b8e4f7afa79fe4a8aced94c3002950694f99`，早于本轮提交。六份已跟踪证据覆盖 Qoder、OpenAI Chat 和 Anthropic；OpenAI Responses 没有真实端点证据。证据文件没有运行时 HEAD SHA，无法仅凭文件确认它们测试的确切提交。
- 用户指出 GitHub 已配置模型并授权调用。`E2E LLM` 在最终提交 `1cfbed5feaf30cf368e8694314f0b33805c3ba41` 自动识别 Anthropic 协议和模型 `DeepSeek-V4.1-Flash-1017-Event`；[run 41638870512](https://github.com/kikoiio/Bitori/actions/runs/41638870512) 通过，5 次迭代、309 输出 token、任务产物校验通过、事后阈值未超额。对应 artifact `e2e-evidence-auto`（604 字节）已核实上传，保留至 2026-11-10；JSON 确认 `workingTreeClean: true` 和完整 commit SHA。当前 GitHub 只配置这一组通用 endpoint/key/model，因此不将同一 Anthropic endpoint 冒充成其余三种协议。
- 本计划开始前最近一次 Linux 桌面 smoke 和打包成功记录是 2026-10-28。那次只启动开发入口和 `linux-unpacked`；AppImage 与 deb 只构建并上传，未启动，桌面 smoke 也没有覆盖“本会话”和“永久允许”。当前完整验收已在 run 41637023628 通过。
- 最近一次 SWE-bench Lite 23 题开发集记录为 2026-10-28、agent SHA `ff9a4fb8ea70d9c0a7d2191086af99925a07069d`：23/23 题有结果，但 8 个 `agent_error`、7 个 `unresolved`、8 个 `infrastructure_error`，没有 `resolved`。结果中的问题包括模型工具调用错误、Groq 速率/上下文限制及 gold 环境验证失败；不能当作当前版本验收。
- 当前版本第 0 题在 run [41640309946](https://github.com/kikoiio/Bitori/actions/runs/41640309946)（5 次迭代）与 [41641115352](https://github.com/kikoiio/Bitori/actions/runs/41641115352)（10 次迭代）均以 `agent_error` 结束、补丁为空。轨迹证明初始 Git ownership 报错随后由 Agent 自行加入精确 `safe.directory` 配置并恢复；不能将它当作持续根因。第二次轨迹还显示 Agent shell 的 `python` 是系统 3.11.5，复现代码因 `collections.Mapping` 失败；gold grader 使用镜像内 `/opt/miniconda3/envs/testbed/bin/python`。随后为 Agent shell 统一 testbed `PATH`，并修正合法 U+FFFD 字符被误判为轨迹截断及固定写死“20 次”的迭代上限错误提示。补丁和 9 项 Python runner 测试、17 项 AgentRunner 测试已通过；新提交的 CI 与云端诊断仍待运行。
- TUI 的模拟终端测试覆盖光标行列、中文折行、输入、排队和取消，且已由修复后提交 `7bca1f1` 的三平台 `Check` 运行并通过。它没有启动 CLI 做真实终端交互验收。
- 桌面权限引擎此前把“本会话允许”加入工作区运行时共享规则，没有按对话 `sessionId` 隔离；这会让另一个聊天复用临时授权。当前实现改为会话 ID 作用域，引擎与 AgentRunner 回归测试通过，桌面跨会话审批 smoke 也在 run 41637023628 通过。
- 用户于 2026-11-03 取消云同步；决定见 [ADR 0001](docs/decisions/0001-cloud-sync-out-of-scope.md)。多模态、会话导入和自动断点续跑仍不支持且待决定。
- 用户于 2026-11-03 接受安全文档列出的五项当前残留风险；决定见 [ADR 0002](docs/decisions/0002-accept-current-security-residual-risks.md)。
- 用户要求继续 RSI 并允许调用可用模型。受控 workflow 将使用 GitHub 已配置的 Anthropic/DeepSeek profile，按 smoke 文件既有硬上限执行一题/一个候选/90 分钟/100 次请求/2,000,000 tokens；运行及 artifact 核验待完成。
- Anthropic SDK 在自定义 base URL 后请求 `/v1/messages`；RSI gateway 归一化原本会丢失自定义 `/anthropic` 前缀的 `/v1`。现已在 `upstream_base` 为该协议补齐版本段，并由测试覆盖根地址、自定义前缀和完整 endpoint 地址。
- 本机 `/usr/bin/x-terminal-emulator` 指向 Ptyxis；已将其设为真实终端光标验收目标，实际显示仍未验收。

## 并行安排

主执行者拥有 `PLAN.md`、最终汇总、文档改动和所有集成验证。三个只读审查分别检查互不重叠的资料，报告路径、当前证据、明确的缺口和所需权限。审查者不运行测试、不访问凭据、不触发云端工作流，也不修改仓库文件。

| 审查 | 范围 | 输出 |
|---|---|---|
| A | TUI、桌面平台、GitHub Actions 验收 | 哪些平台和提交已有证据，哪些验收可在现有工作流执行，哪些需要新增规格或流程 |
| B | Provider E2E 证据与测试范围 | 三种协议证据的提交和覆盖，当前提交的缺口，重跑所需凭据、费用与上传范围 |
| C | 安全残留风险、未决产品功能、暂停中的 RSI | 将明确待办、需用户决策、接受风险和暂停事项分开，并列出对应门槛 |
| D | Provider 证据提交 SHA 字段 | 只修改 `tests/acceptance/e2e-providers.ts`；读取 GitHub SHA 或本地 HEAD，不运行 Provider、不接触凭据 |

审查结果合并后再修改产品文档或代码。D 完成并通过主执行者审查后，主执行者再补上工作树洁净标记和独立结果目录。共享文件由主执行者串行整合。大规模检查和 GUI 演练不在本机并发运行。

## 待办状态

| 项目 | 当前状态 | 完成证据或门槛 |
|---|---|---|
| 全平台代码检查 | 已验证 | 修复后提交 `7bca1f1b9682729c7f3197ef1e4cbdf258fa01e4` 的 Ubuntu/Windows/macOS 完整 `Check` 全通过，见 run 41636966238 |
| 临时会话授权边界 | 已验证 | 23 项定向单测及 Linux 桌面跨会话 smoke 通过，见 run 41637023628 |
| Linux 桌面 smoke 与打包 | 已验证 | 开发版、`linux-unpacked`、AppImage 与 deb 启动 smoke 通过；构件和截图已上传，见 run 41637023628 |
| 桌面审批选项 | 已验证 | 一次/本会话/永久/拒绝、授权范围与持久化 smoke 均通过，见 run 41637023628 |
| Provider 证据可追溯性 | 已验证 | Anthropic 结果含完整 commit SHA、干净工作树和用量，见 run 41638870512 与 `e2e-evidence-auto` artifact |
| 真实 Provider 验收 | 当前 GitHub 配置的 Anthropic profile 已通过 | 模型 `DeepSeek-V4.1-Flash-1017-Event`；309 输出 token；另三种协议没有各自 endpoint/key 配置，见 run 41638870512 |
| SWE-bench Lite 开发集 | 两次单题诊断未完成，修复后待复验 | run 41640309946 与 41641115352 均为空补丁；已修正 testbed Python 环境和轨迹诊断，下一轮在新提交上最多 10 次迭代/600 秒；详见 [评测说明](evaluation/README.md) |
| 真实终端观感 | 目标已定为 Ptyxis，等待显示验收 | 本机 `/usr/bin/x-terminal-emulator` 指向 Ptyxis；自动测试不能证明真实终端显示效果 |
| Windows/macOS 桌面支持 | 文档目标范围之外 | 产品目标是跨平台终端和 Linux 桌面；新增桌面平台要另作决定 |
| 多模态 | 等产品决定 | 继续不支持、支持或调研 |
| 云同步 | 用户取消，保持不支持 | [ADR 0001](docs/decisions/0001-cloud-sync-out-of-scope.md) |
| 会话导入 | 等产品决定 | 继续不支持、支持或调研 |
| 自动断点续跑 | 等产品决定 | 继续不支持、支持或调研 |
| 仓库说明/skills/命令进入模型上下文 | 用户接受当前风险 | [ADR 0002](docs/decisions/0002-accept-current-security-residual-risks.md)；克隆仓库前仍需审查 |
| 模型诱导用户批准 | 用户接受当前风险 | 审批继续显示真实调用参数，见 ADR 0002 |
| 本地工作区信任清单无密码学保护 | 用户接受当前风险 | 当前为本地文件，路径移动需重新信任，见 ADR 0002 |
| bypass 档跳过逐次审批 | 用户接受当前风险 | 仅在受信环境使用并持续显示提示，见 ADR 0002 |
| trace/历史包含未知机密 | 用户接受当前风险 | 已知配置密钥会脱敏；分享前仍需人工检查未知内容，见 ADR 0002 |
| RSI | 用户已授权恢复有界 smoke | 运行 GitHub 通用 Anthropic/DeepSeek profile；使用 smoke.json 既有预算上限，云端结果待核实 |

## 阶段

1. **完成盘点。** 已汇总三个独立审查与当前项目文档；把实现缺陷、验收缺口、风险处置、产品决定和暂停项目分别记录。
2. **补齐本地可执行实现。** 已按会话 ID 隔离临时授权；桌面 smoke 增加四项审批选择和范围断言；Linux 工作流新增 AppImage/deb 启动；Provider 证据新增提交 SHA 与工作树洁净标记及独立结果目录。定向测试（23 项）、类型检查、改动文件 lint、脚本语法、工作流 YAML 解析、6 份文档本地链接与差异检查均通过。
3. **关闭外部验收。** 先前版本三平台 `Check` 与 Linux desktop workflow 通过，真实 Provider E2E 通过。SWE-bench 单题两次未完成后发现并修正 Agent shell Python 版本与轨迹误报，需在当前改动经 CI 后用 10 次迭代/600 秒重跑第 0 题。RSI 已接通同一 GitHub 配置；在 CI 通过后运行一个有界 smoke 并核对 artifact。
4. **处理 TUI 与桌面目标范围。** 当前基线的模拟光标/输入用例由三平台 Check 通过。真实终端目标设为 Ptyxis，实际显示仍待验收。Windows/macOS 桌面支持仍在现有范围之外。
5. **记录安全处置。** 用户接受五项既有残留风险；在安全文档和 ADR 中记录范围与日期，风险事实及现有控制保持可见。
6. **处理产品方向。** 用户取消云同步；多模态、会话导入和自动断点续跑继续等产品决定。获准方向另拆为有范围、有测试和验收条件的实现阶段。
7. **执行有界 RSI smoke。** 用户明确要求继续并授权可用模型；使用已配置的 Anthropic/DeepSeek profile 及 `smoke.json` 的预算限制，结果不自动合并。
8. **最终核验。** 每项保留证据或明确的延期理由；更新文档索引；确认测试、工作流、分支和工作区状态，并审阅决策轨迹。

## 已完成的云端验收

- 用户授权使用免费云资源后，将 `master` 推送至提交 `7d58863`，并触发三平台检查；初次运行暴露 Windows 光标稳定性测试的 20 秒截止问题，已在 `7bca1f1` 修复并由 run 41636966238 全平台复验通过。
- 手动运行 Linux desktop workflow，初次 AppImage 测试因 AppImage 参数顺序失败；改用 `APPIMAGE_EXTRACT_AND_RUN=1` 后，run 41637023628 的所有 smoke 通过。`desktop-packaged-linux`（237,007,447 字节）与 `desktop-screenshots`（870,292 字节）已只读核实上传，保留至 2026-11-10。

## 剩余范围与成本边界

- **Provider 覆盖范围。** 当前 Anthropic/DeepSeek 配置已通过一次固定任务；25k token / 1 credit 阈值是运行后检查，不是硬限制。若要验收 Qoder、OpenAI Chat 或 OpenAI Responses，需分别配置正确 endpoint/key，不能把 Anthropic endpoint 直接当作这些协议。
- **SWE-bench Lite 开发集。** 工作流已接入仓库通用模型配置，默认单题，最多 5 次迭代/600 秒；下一轮单题诊断将设 10 次迭代/600 秒。工作流没有总 token/美元硬上限。Docker runner 会下载固定公开数据和镜像，将公开任务发送给 Provider；隔离容器中的 Agent 可访问配置凭据和网络。结果、轨迹、诊断、补丁和汇总 artifact 保留 7 天。完整 23 题集仍未授权。
- **RSI smoke。** 用户已授权恢复并调用可用模型。工作流改用现有通用 Anthropic/DeepSeek profile，使用 Docker、最多 90 分钟、100 次模型请求、2,000,000 tokens 和 32,000 输出 tokens，并上传既定报告、账本、候选证据和轨迹，保留 7 天。此处额度是实验硬上限，不是价格承诺。
- **产品功能。** 云同步已由用户取消，保持不支持。多模态、会话导入、自动断点续跑仍待决定，未获选择的方向保持未实现。
- **安全风险处置。** 用户接受 `docs/reference/security.md` 列出的五项当前残留风险：仓库说明/skills/命令进入模型上下文；模型可能诱导用户批准；本地工作区信任清单无密码学保护；bypass 档跳过逐次审批；trace/历史可能包含未知机密。事实和现有控制保留在安全文档，见 ADR 0002。
- **终端与桌面范围。** 已将本机默认终端 Ptyxis 设为真实光标/输入验收目标；实际显示仍未核验。Windows/macOS 桌面支持仍在现有范围之外。

## 验收记录

每个阶段结束时，把真实命令、提交 SHA、工作流链接或文件行号写入 `.audit/bitori-backlog.tsv`。未运行的检查记为 `INCONCLUSIVE`，不得记作通过。

`.audit/` 已由仓库 `.gitignore` 排除。为让项目级执行记录可复核，本轮会将 `.audit/bitori-backlog.tsv` 作为明确文件加入提交；临时 checklist 仍只保存在本地。
