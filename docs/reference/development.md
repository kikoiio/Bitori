# 开发与测试

## 文档维护

项目意图、当前架构和查阅资料分别维护，入口见 [文档索引](../README.md)。普通文档使用小写英文主题名，多词使用连字符；文档变化时同步更新索引。历史工作由 Git 保存。

## 本地开发

使用 Node.js 24 和 npm，在仓库根目录执行 `npm ci` 后，以 `npm run dev -- --profile <name>` 启动；配置见 [配置与扩展](configuration.md)。`npm run build` 输出 `dist/`，`npm start` 运行编译后的终端入口。生成目录与本地密钥不应提交。

Linux Electron 日常迭代用 `npm run desktop`。`npm run desktop:package` 把安装形态写到 `out/desktop/`（`linux-unpacked`、AppImage、deb），供测试使用，配置禁止 publish。两者均需 Electron 依赖、图形环境及适当资源；启动后须选择并信任工作区。

## 验证

根据改动选择相关测试，完整检查包括类型、lint、测试和构建：

```sh
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm run build
npm run check
node dist/bin/bitori.js --help
```

`npm test` 的 `pretest` 会先构建；`npm run check` 包含 `npm test` 和再次构建。自动测试使用模拟客户端、临时 SQLite 或本地服务；真实模型验收依赖凭据、网络及供应商配额，结果应单独记录，不能由模拟测试推断。`tests/acceptance/e2e-openrouter.ts` 是现有真实端点测试入口。

## 贡献与验收

改动前阅读 [产品目标](../intent.md) 和 [架构](../architecture.md)，明确问题、预期行为、平台及权限边界。为行为变化补充适当测试，同步修改受影响的文档和配置模板；PR 说明影响、兼容性、已执行和未执行的检查。不要提交密钥、个人会话、日志或未经授权的工作区内容。

真实模型或平台验收按改动选择以下场景，记录所用提交、系统、模型、步骤和实际结果；历史单次结果不代表当前版本通过。

| 场景 | 验证重点 |
|---|---|
| 读取后编辑 | `read_file` 先于 `edit_file`，修改正确，模型给出非空结果；可用上述真实端点脚本。 |
| Plan/Do | Plan 只读、提醒不进入历史消息，存在计划后 `/do` 执行，取消后任务收尾。 |
| MCP | stdio/HTTP 工具发现、审批和结果回灌；故障服务不影响其他服务，退出后子进程与会话被关闭。 |

完整构建、全量测试、GUI 和打包等重型操作遵循当前资源与云端授权规则；不得以本机内存充足替代云端优先要求。

## 测试在哪里跑

默认用 GitHub Actions 短生命周期 runner。本机看 TUI 观感和 `npm run desktop` 交互；打包冒烟与跨平台 check 由 CI 执行。

| 层 | 测什么 | 在哪跑 | 何时 |
|---|---|---|---|
| Check | 类型、lint、单元/集成/TUI 测试、`dist/` 构建 | GitHub-hosted Ubuntu/Windows/macOS | 每个 PR 和 `master` |
| 终端 | 编译后的 CLI/TUI：`node dist/bin/bitori.js` | 含在 Check 里；观感在本机终端 | PR 自动；观感按需本机 |
| 桌面未打包 | `electron .` 会话、审批、工作区信任 | GitHub Actions + Xvfb | PR / `desktop/**` / 手动 |
| 桌面包 | `out/desktop/linux-unpacked` 启动，并抽查 AppImage/deb | 同上；workflow artifact 留 7 天 | 同上 |
| 真实模型 | OpenRouter/Groq 端到端 | 手动 `e2e.yml` | 明确授权后 |
| 评测 | SWE-bench Lite / RSI smoke | 手动评测工作流 | 明确授权后 |

## GitHub Actions

以下按当前工作树的工作流定义描述；每次修改工作流后应以 GitHub Actions 的实际运行结果为准。实际 token 权限、fork PR 的密钥可用性和仓库设置取决于 GitHub 环境；运行或启用前应检查目标、权限、额度以及可能外发的数据。依赖安装会访问包注册表，artifact 上传会向 GitHub 保存所列文件。

| 工作流 | 触发与主要动作 | 凭据、外发和写入 |
|---|---|---|
| [Check](../../.github/workflows/check.yml) | push 到 `master` 或 `desktop/**`、所有 PR、手动；三平台执行 `npm run check` | 未声明模型 secrets 或显式写权限。 |
| [Linux desktop](../../.github/workflows/desktop.yml) | push 到 `desktop/**`、所有 PR、手动；模拟服务冒烟、打包及 `out/desktop/` 包启动 | 未调用真实模型；上传 7 天 AppImage/deb 与截图 artifact。 |
| [E2E LLM](../../.github/workflows/e2e.yml) | 手动；可选择供应商和模型，`__list__` 只列模型 | 使用所选 `OPENROUTER_LLM_API_KEY` 或 `GROQ_LLM_API_KEY`，模型来自输入或对应 `OPENROUTER_MODEL` / `GROQ_MODEL` vars；会向供应商发送请求。 |
| [SWE-bench Lite development](../../.github/workflows/swe-bench-lite.yml) | 手动运行单题或 23 题开发集；见 [评测说明](../../evaluation/README.md) | 使用所选模型供应商的 secret 和 model var；向供应商发送公开任务内容，上传安全证据白名单和汇总 artifact。 |
| [RSI smoke](../../.github/workflows/rsi.yml) | 手动运行受控单题 RSI smoke；默认分支代码、完整基线 SHA 和确认短语 | 使用 `XUNFEI_LLM_API_KEY`、`XUNFEI_OPENAI_RESPONSE_URL` 和 `XUNFEI_MODEL`；向讯飞发送第 0 题内容，上传报告、账本、诊断、假设、补丁、检查、比较、验证和轨迹，不上传 gold、凭据、worktree 或构建产物。 |

模型发送的数据取决于实际测试任务和脚本，不能仅凭此表认定没有敏感内容。工作流、配置或行为变更应同步审查文档和示例，并在 PR 中记录未验证项。
