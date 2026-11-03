# 评测与 RSI

> RSI 状态：**恢复中的有界 smoke**。用户于 2026-11-03 授权继续并调用 GitHub 当前配置的 Anthropic/DeepSeek 模型；单题、单候选 smoke 结果待云端验收。SWE-bench Lite 全 23 题仍未授权。

RSI 指持续改进本项目的 coding-agent harness，不训练或升级底层模型。实现位于 `evaluation/RSI/`：runner 记录安全证据，规则分析器诊断失败，隔离容器生成候选，独立 verifier 检查，控制面在预算内编排并输出可合并审查报告。自动合并、无人值守轮询和正式 300 题测试仍未启用；本次仅恢复一个有界 smoke，结果仍需人工审查。

## SWE-bench Lite 开发集

`benchmarks/swe-bench-lite/` 运行 SWE-bench Lite 的 23 题开发集；这是开发集，不是 300 题正式测试集。数据集 revision 固定在 runner 中，官方评分器版本固定在 GitHub Actions 中。每题先运行官方补丁校验环境，再运行 Bitori 和官方评分。模型使用无审批模式，仅限隔离的临时容器。

最近一次完整开发集记录（2026-10-28，agent commit `ff9a4fb8ea70d9c0a7d2191086af99925a07069d`）覆盖 23/23 题，但结果为 8 个 `agent_error`、7 个 `unresolved`、8 个 `infrastructure_error`，没有 `resolved`。这是旧提交上的诊断记录，不代表当前版本。当前仅获准复验历史第 0 题；全 23 题仍需单独明确范围和预算。工作流自身没有总 token 或美元费用硬上限，且按单题串行。

在提交 `8ac6b327555c0a60b19602d2ecba30d17e2098af` 上，第 0 题的两次诊断分别运行 5 次和 10 次迭代：[run 41640309946](https://github.com/kikoiio/Bitori/actions/runs/41640309946) 与 [run 41641115352](https://github.com/kikoiio/Bitori/actions/runs/41641115352) 均以 `agent_error` 结束、补丁为空，gold 环境均通过。两份轨迹都显示初次 Git dubious ownership 错误随后由 Agent 自行设置 `safe.directory` 并继续执行；这不是持续阻塞。第二次 Agent shell 的 `python` 是系统 3.11.5，复现代码因 `collections.Mapping` 失败，而 runner 官方评分使用镜像内 `testbed` Python。已将 Agent 子进程的 `PATH` 指向该环境，并修正合法 U+FFFD 字符误报轨迹截断及迭代上限错误提示。修复后的单题复验已随 `1eb870f` 推送；其三平台 Check 已由 run 41644656315 通过，单题复验将在最终文档/证据提交的 Check 通过后派发。

手动运行 `.github/workflows/swe-bench-lite.yml`：`index=0` 至 `22` 为单题，`index=all` 为完整开发集；默认运行第 0 题，Provider 默认使用仓库配置的 `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`（当前配置为 Anthropic 协议）。也可选择 openrouter、groq 或 xunfei 专用变量/secret。每题可选最大迭代次数（默认 5）和 Agent wall-clock 上限（默认 600 秒）；每题独立 runner、单题串行。讯飞使用 `XUNFEI_MODEL`、`XUNFEI_OPENAI_RESPONSE_URL` 和 `XUNFEI_LLM_API_KEY`，协议为 `openai-responses`；完整 `/responses` 地址会转为 SDK base URL，避免重复拼接路径。runner 需要联网下载依赖、公开数据和镜像，并将公开任务内容发送给模型供应商。模型产生的命令可访问容器内的模型凭据和网络，应只使用限额、可撤销的专用密钥。工作流没有总 token 或美元费用硬上限，运行结果只提供用量证据，不保证实际费用上限；请勿对不可信的工作流或数据集开放仓库密钥。

每题上传安全证据白名单：`result.json`、`trajectory.jsonl`、`diagnosis.json`、`solution.patch` 和 `artifacts.json`。不上传 gold 数据、`instance.json`、原始 thinking、完整请求上下文、凭据、worktree 或构建产物。轨迹与补丁均有大小上限并经过脱敏与二次扫描；导出补丁若被改写会标记为不可重放，评分始终使用容器内真实补丁。`resolved`、`unresolved`、`agent_error`、`provider_error` 和 `infrastructure_error` 分开记录；若作业启动前失败或超时，可能没有结果文件，汇总会标记缺失而不是当作成功。

汇总作业将逐题结果与诊断分类写入 `swe-lite-summary` artifact；缺题、任务重复或运行错误会使汇总失败。旧版运行没有汇总作业时，可将各 artifact 下载到同一目录后运行 `python3 evaluation/RSI/aggregate.py <目录> --indices '[0,1]' --output <报告.json>`。

## 有界 RSI 实验

实验由显式命令启动，无 schedule、后台循环或自动推送：

```bash
python3 evaluation/RSI/loop.py \
  --config evaluation/RSI/smoke.json \
  --baseline-ref <40位基线提交SHA> \
  --output <仓库外的新目录>
```

阶段顺序为 preflight → baseline → analyze → propose → commit → verify → evaluate → decide → report；每次迁移原子落盘到 `state.json` 和 `ledger.jsonl`。已完成阶段可在同一实验目录恢复且不重复计费；中断的 attempt 记录为中断，不伪装成功。

- **记录与诊断**：`analyze.py` 只从结果和完整轨迹中给出可重复分类。缺失轨迹、gold/环境失败、provider/infra 错误会阻止候选生成；仅 `iteration_limit` 不代表已找到根因。
- **隔离与预算**：候选与解题容器运行非特权、只读根文件系统、资源受限且仅连接内部网络；唯一模型出口是可信转发器，真实密钥不进入执行容器。预算按账本累计请求和 token，耗尽即停止；缺少 usage 时保守记账。
- **候选**：控制面从冻结的 base SHA 创建 `rsi/<experiment-id>/<candidate-id>` 分支与独立 worktree，只允许配置中列出的源码和新增单测，拒绝受保护文件、符号链接、二进制或题目特判。候选提交固定 head SHA，不修改 master。
- **Verifier**：`verify()` 是纯函数，只接受可信执行器生成、绑定 experiment/base/head/verifier SHA 的回执。缺少检查、环境失败、证据不完整或结果不稳定均为 `inconclusive`，不能合并。`verification.json` 中的 `merge_authorized` 恒为 false。
- **比较**：正式解题率对比要求两次运行全部完成；可靠性对比允许比较同配置的 `agent_error`、`iteration_limit` 等终态，并单独报告，不把基础设施故障说成能力差异。报告同时给出配对结果、token、耗时、预算消耗和未验证项。

`smoke.json` 默认只跑第 0 题、1 个候选、最多 2 次解题运行；解题 30 轮、改进 10 轮、串行执行，总计 90 分钟、100 次模型请求、2,000,000 累计 token。每次请求的输出上限为 32,000 tokens，并同时受剩余累计 token 预算约束。smoke 只验证链路，verifier 结论固定为 `inconclusive`，不能作为合并依据。完整 dev、重复实验、正式测试集和真实云端开销需要单独的显式配置与授权。

`.github/workflows/rsi.yml` 是仅 `workflow_dispatch` 的受控 smoke 入口：代码来自默认分支，输入完整基线 SHA，并要求输入确认短语后才调用模型。当前 workflow 使用仓库通用 `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`，协议为 Anthropic。固定预算为 90 分钟、100 次请求、2,000,000 累计 tokens；每次请求最多输出 32,000 tokens，且受剩余累计 token 预算约束。只跑第 0 题和一个候选。它上传报告、账本、诊断、假设、补丁、检查、比较、验证和轨迹，保留 7 天。真实云端运行、可信 required check 与分支保护仍待验收；verifier 只能作为诊断工具。

`compare.py` 与 `experiment.py` 仍可用于已有目录的离线比较和人工审查报告。旧结果缺少可比性指纹时只作诊断素材，不作为严格性能基线。

数据和镜像留在云端 runner；artifact 可能包含运行元数据，应按仓库权限管理。UI/UX、审批体验与跨平台验收不由该 benchmark 代替。

对 pvlib 任务，如果标准答案因 NumPy 2 移除 `np.Inf` 导致测试加载失败，runner 将该任务的镜像中的 NumPy 固定为 1.26.4，并重新验证标准答案；改动记录在 `environment_adjustments`。调整后的结果应与原始镜像结果区分。
