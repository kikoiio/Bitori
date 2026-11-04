# 评测与 RSI

## 当前状态

截至 2026-11-04，RSI 已按单次明确授权执行一轮受控 smoke；SWE-bench Lite 按项目决定归入 RSI 评测范围，基准扩跑仍暂停。当前没有后台定时运行，后续实验需重新核对授权范围与预算。项目产品实现的已完成项与验收边界见[开发参考](development.md)。

最近一次 RSI smoke 为基线提交 `93ac7e25585413da8ea08e8967fd97ae7d41bc43` 的 run [41781675905](https://github.com/kikoiio/Bitori/actions/runs/41781675905)，终态为 `no_candidate`。离线检查、preflight 和 baseline 执行完成；网关记录 23 次模型请求全部成功，累计 857,766 tokens，未耗尽预算。task 0 为 `unresolved`，Agent 自然结束，采集补丁为空，未进行补丁评分，也未生成 RSI 候选。这次实验未通过，不构成改进或合并依据。

已采集轨迹中的 7 次 `run_command` 均被权限拒绝。原因已定位：runner 写入项目级 `permissions.local.yaml` 的旧 `mode: bypass`，当前版本会忽略它；而 `exec` 没有交互审批，故调用被拒绝。原始轨迹也触及 8 MiB 采集上限，缺少结束事件和最后一轮响应。前者解释了工具调用失败，但由于轨迹不完整，仍不能断定它是空补丁的唯一原因。[结果 artifact](https://github.com/kikoiio/Bitori/actions/runs/41781675905/artifacts/13299263556) 已下载核验 SHA256，包含报告、账本、诊断和基线轨迹，GitHub 保留至 2026-11-11。未自动重跑或合并。

本地 runner 已完成跟进修复：在一次性容器的用户级权限文件中显式允许基准所需的 `run_command`、`edit_file` 和 `write_file`，保持 `default` 档；权限 glob 使用 `**` 覆盖完整命令和嵌套路径。轨迹改为 gzip 传输，解压受 32 MiB 上限约束，并核对完整性。回归用例验证权限配置、glob 匹配和大于旧上限的轨迹。**尚未在 GitHub Actions 复验**，因此 RSI 仍未完成。

最近一次 SWE-bench Lite 23 题开发集结果来自 2026-10-28 的旧 agent commit：8 个 `agent_error`、7 个 `unresolved`、8 个 `infrastructure_error`，没有 `resolved`。它不是当前版本验收结果。此前第 0 题两次诊断也未产出补丁；相关修复记录见 [run 41644656315](https://github.com/kikoiio/Bitori/actions/runs/41644656315)。

## 受控 RSI smoke

实现位于 [`evaluation/RSI/`](../../evaluation/RSI/)；它针对 coding-agent harness 做有界候选实验，不训练底层模型。控制面负责记录、诊断、预算和候选比较；候选只在隔离容器中执行。verifier 只读取绑定实验与提交 SHA 的可信回执，不写 Git、不授权合并。完整流程说明见代码中的 [RSI loop](../../evaluation/RSI/loop.py) 和配置 [`smoke.json`](../../evaluation/RSI/smoke.json)。

GitHub 的 [RSI workflow](../../.github/workflows/rsi.yml) 仅支持手动 `workflow_dispatch`。配置限定单题、单候选，最长 90 分钟、100 次请求、累计 2,000,000 tokens，每次请求最多输出 32,000 tokens；超限即停止。运行前需要完整基线 SHA 和确认短语。报告、账本、诊断、补丁、检查及轨迹等白名单 artifact 保留 7 天。verifier 的 smoke 结论固定为 `inconclusive`，不能作为合并依据。

工作流要求从仓库默认分支触发，并检出该事件的精确 SHA，以保持执行和证据来源一致。GitHub 对手动触发使用所选 ref 上的 workflow 定义，因此该检查只是防止误选分支的护栏；执行前仍须确认目标默认分支代码已审阅。

云端复验前须取得新的 workflow 运行授权，并重新核对模型配置、数据发送范围、凭据类型与实验预算。不要把历史 workflow 授权视为未来运行授权。

## SWE-bench Lite

[开发集 workflow](../../.github/workflows/swe-bench-lite.yml) 覆盖 23 个开发任务，不是正式 300 题评测。它会将公开任务内容发送给配置的模型供应商，并在隔离容器中执行模型生成的命令；workflow 没有总 token 或美元硬上限。运行前必须重新确定授权、密钥、预算和任务范围。当前暂停期间不派发任务。

评测脚本与报告聚合器位于 `evaluation/benchmarks/`、`evaluation/RSI/` 和 `evaluation/tests/`。历史结果保留在 GitHub workflow artifact 或对应评测数据中，不在本说明重复保存运行日志。
