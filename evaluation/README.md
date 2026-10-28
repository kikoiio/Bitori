# 评测与 RSI

RSI 指持续改进本项目的 coding-agent harness，不训练或升级底层模型。实现位于 `evaluation/RSI/`：runner 记录安全证据，规则分析器诊断失败，隔离容器生成候选，独立 verifier 检查，控制面在预算内编排并输出可合并审查报告。自动合并、无人值守轮询和正式 300 题测试仍未启用；未完成事项记录在 [docs/PLAN.md](../docs/PLAN.md)。

## SWE-bench Lite 开发集

`benchmarks/swe-bench-lite/` 运行 SWE-bench Lite 的 23 题开发集；这是开发集，不是 300 题正式测试集。数据集 revision 固定在 runner 中，官方评分器版本固定在 GitHub Actions 中。每题先运行官方补丁校验环境，再运行 Bitori 和官方评分。模型使用无审批模式，仅限隔离的临时容器。

手动运行 `.github/workflows/swe-bench-lite.yml`：`index=0` 至 `22` 为单题，`index=all` 为完整开发集；选择 openrouter、groq 或 xunfei。每题独立 runner，单题串行，减少共享模型服务的限流。模型、API key 和需要的接口地址来自对应仓库变量与 secret。讯飞使用 `XUNFEI_MODEL`、`XUNFEI_OPENAI_RESPONSE_URL` 和 `XUNFEI_LLM_API_KEY`，协议为 `openai-responses`；完整 `/responses` 地址会转为 SDK base URL，避免重复拼接路径。runner 需要联网下载依赖、数据、镜像，并将公开任务内容发送给模型供应商。模型产生的命令可访问容器内的模型凭据和网络，应只使用限额、可撤销的专用密钥。请勿对不可信的工作流或数据集开放仓库密钥。

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

`smoke.json` 默认只跑第 0 题、1 个候选、最多 2 次解题运行；解题 30 轮、改进 10 轮、串行执行，总计 90 分钟、100 次模型请求、2,000,000 token。smoke 只验证链路，verifier 结论固定为 `inconclusive`，不能作为合并依据。完整 dev、重复实验、正式测试集和真实云端开销需要单独的显式配置与授权。

`.github/workflows/rsi.yml` 是仅 `workflow_dispatch` 的受控 smoke 入口：代码来自默认分支，输入完整基线 SHA，并要求输入确认短语后才调用讯飞。它上传与本地实验相同的证据白名单（报告、账本、诊断、假设、补丁、检查、比较、验证、轨迹），上限 7 天。真实云端运行、可信 required check 与分支保护尚未验收，见 [docs/PLAN.md](../docs/PLAN.md)；在这些门槛完成前，verifier 只能作为诊断工具。

`compare.py` 与 `experiment.py` 仍可用于已有目录的离线比较和人工审查报告。旧结果缺少可比性指纹时只作诊断素材，不作为严格性能基线。

数据和镜像留在云端 runner；artifact 可能包含运行元数据，应按仓库权限管理。UI/UX、审批体验与跨平台验收不由该 benchmark 代替。

对 pvlib 任务，如果标准答案因 NumPy 2 移除 `np.Inf` 导致测试加载失败，runner 将该任务的镜像中的 NumPy 固定为 1.26.4，并重新验证标准答案；改动记录在 `environment_adjustments`。调整后的结果应与原始镜像结果区分。
