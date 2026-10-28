# 评测与 RSI

`benchmarks/swe-bench-lite/` 运行 SWE-bench Lite 的 23 题开发集；这是开发集，不是 300 题正式测试集。数据集 revision 固定在 runner 中，官方评分器版本固定在 GitHub Actions 中。每题先运行官方补丁校验环境，再运行 Bitori 和官方评分。模型使用无审批模式，仅限隔离的临时容器。

手动运行 `.github/workflows/swe-bench-lite.yml`：`index=0` 至 `22` 为单题，`index=all` 为完整开发集；选择 openrouter 或 groq。每题独立 runner，最多两题并行。模型和 API key 来自对应仓库变量与 secret。runner 需要联网下载依赖、数据、镜像，并将公开任务内容发送给模型供应商。模型产生的命令可访问容器内的模型凭据和网络，应只使用限额、可撤销的专用密钥。请勿对不可信的工作流或数据集开放仓库密钥。

每题上传 `result.json`，包含任务、数据集版本、模型、代码提交、结果、耗时及部分用量，不上传模型回复、补丁或运行轨迹。`resolved`、`unresolved`、`agent_error` 和 `infrastructure_error` 分开记录；若作业启动前失败或超时，可能没有结果文件。为检查完整性需确认 23 个独立任务都产生了结果。

汇总作业将逐题结果写入 `swe-lite-summary` artifact；缺题、任务重复或运行错误会使汇总失败。旧版运行没有汇总作业时，可将各 artifact 下载到同一目录后运行 `python3 evaluation/rsi/aggregate.py <目录> --indices '[0,1]' --output <报告.json>`。

`rsi/compare.py <baseline目录> <candidate目录>` 比较两次结果，拒绝不同任务、数据集、模型或未完成的运行。该工具是 RSI 的对比起点；尚未自动生成修改、执行候选版本、保护留出集或判断结果统计显著性。现有 `scripts/auto-improve.sh` 是独立的 draft PR 流程，尚未接入这里。更改需要人工审查，不会自动合并。

`rsi/experiment.py --hypothesis '<假设>' --baseline <目录> --candidate <目录> --output <报告.json>` 在相同约束下保存两次提交、改进假设和逐题对比，并标记为等待人工审查。公开数据集 revision 与评分器顶层版本已固定；上游镜像标签和 Python 间接依赖尚未固定，当前结果还不能保证完全可复现。

数据和镜像留在云端 runner；artifact 可能包含运行元数据，应按仓库权限管理。UI/UX、审批体验与跨平台验收不由该 benchmark 代替。
