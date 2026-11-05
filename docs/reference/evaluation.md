# 评测与 RSI

## 当前状态

SWE-bench Lite 扩跑保持暂停，当前没有后台定时运行。最近的受控 RSI smoke 使用 Agent 基线与 verifier SHA `fa73ce99c3dbbd4410a284cd2e9279cab57c89ec`，未找到改进候选；后续实验需重新核对授权范围与预算。产品验收证据见[开发参考](development.md)。

最近的 [RSI run 41838378031](https://github.com/kikoiio/Bitori/actions/runs/41838378031) 记录 24 次请求、752,118 tokens、343.3 秒，均在配置预算内。task 0 基线为 `resolved`，Agent 自然结束；58 条事件的轨迹完整，22 次 `run_command` 没有人工审批拒绝；一次绝对路径 `read_file` 被工作区沙箱拒绝。

实验终态是 `no_candidate`，因为基线已解决任务，因此没有请求候选改进。GitHub workflow 以失败状态结束，是因为该终态当前返回退出码 1；报告没有候选或改进 verdict。这次运行证明当前代码上的 runner 权限路径和轨迹采集可用，但不构成代码改进、合并或 RSI smoke 的 `pass` 结论。

## 受控 RSI smoke

实现位于 [`evaluation/RSI/`](../../evaluation/RSI/)；它针对 coding-agent harness 做有界候选实验，不训练底层模型。控制面负责记录、诊断、预算和候选比较；候选只在隔离容器中执行。verifier 只读取绑定实验与提交 SHA 的可信回执，不写 Git、不授权合并。完整流程说明见代码中的 [RSI loop](../../evaluation/RSI/loop.py) 和配置 [`smoke.json`](../../evaluation/RSI/smoke.json)。

GitHub 的 [RSI workflow](../../.github/workflows/rsi.yml) 仅支持手动 `workflow_dispatch`。配置限定单题、单候选，最长 90 分钟、100 次请求、累计 2,000,000 tokens，每次请求最多输出 32,000 tokens；超限即停止。运行前需要完整基线 SHA 和确认短语。报告、账本、诊断、补丁、检查及轨迹等白名单 artifact 保留 7 天。verifier 的 smoke 结论固定为 `inconclusive`，不能作为合并依据。

工作流要求从仓库默认分支触发，并检出该事件的精确 SHA，以保持执行和证据来源一致。GitHub 对手动触发使用所选 ref 上的 workflow 定义，因此该检查只是防止误选分支的护栏；执行前仍须确认目标默认分支代码已审阅。

既有云端复验已结束。后续云端实验需明确的 workflow 授权，并重新核对模型配置、数据发送范围、凭据类型与实验预算；历史授权不自动覆盖未来运行。

## SWE-bench Lite

[开发集 workflow](../../.github/workflows/swe-bench-lite.yml) 覆盖 23 个开发任务，不是正式 300 题评测。它会将公开任务内容发送给配置的模型供应商，并在隔离容器中执行模型生成的命令；workflow 没有总 token 或美元硬上限。运行前必须重新确定授权、密钥、预算和任务范围。当前暂停期间不派发任务。

2026-10-28 的旧版本 23 题开发集没有 `resolved`（8 个 `agent_error`、7 个 `unresolved`、8 个 `infrastructure_error`），不能作为当前版本验收结果。历史修复见 [run 41644656315](https://github.com/kikoiio/Bitori/actions/runs/41644656315)。

评测脚本与报告聚合器位于 `evaluation/benchmarks/`、`evaluation/RSI/` 和 `evaluation/tests/`。结果写入被 Git 忽略的 `evaluation/results/` 或 workflow artifact；artifact 按工作流保留期自动过期，需长期留存时应在过期前另行归档。旧运行日志和已移除的结果可从 Git 历史查看。
