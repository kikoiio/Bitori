# 开发与测试

## 文档维护

`docs/` 只保留四个规范来源：`product.md` 说明目标与状态，`architecture.md` 描述当前模块与数据路径，`configuration.md` 定义配置与扩展用法，`development.md` 记录开发、验证和贡献流程。文件名采用小写英文主题名，需要分词时使用连字符；日期和验收状态写在正文。新主题先考虑归入现有文档，不为一篇短文或两个模板创建分类目录；导航只链接规范来源，不复制整份内容。根目录 `AGENTS.md` 是唯一代理工作约定，配置模板放在根目录，README 只保留项目简介。

## 本地开发

使用 Node.js 24 和 npm，在仓库根目录执行 `npm ci` 后，以 `npm run dev -- --profile <name>` 启动；配置见 [配置与扩展](configuration.md)。`npm run build` 输出 `dist/`，`npm start` 运行编译结果。生成目录与本地密钥不应提交。Linux Electron 开发入口为 `npm run desktop`；`npm run desktop:package` 构建 Linux AppImage 和 deb 作为开发验证产物。两者均需 Electron 依赖、图形环境及适当资源；启动后须选择并信任工作区。

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

改动前阅读 [产品目标](product.md) 和 [架构](architecture.md)，明确问题、预期行为、平台及权限边界。为行为变化补充适当测试，同步修改受影响的文档和配置模板；PR 说明影响、兼容性、已执行和未执行的检查。不要提交密钥、个人会话、日志或未经授权的工作区内容；漏洞按 [安全策略](../SECURITY.md) 私下报告。

真实模型或平台验收按改动选择以下场景，记录所用提交、系统、模型、步骤和实际结果；历史单次结果不代表当前版本通过。

| 场景 | 验证重点 |
|---|---|
| 读取后编辑 | `read_file` 先于 `edit_file`，修改正确，模型给出非空结果；可用上述真实端点脚本。 |
| Plan/Do | Plan 只读、提醒不进入历史消息，存在计划后 `/do` 执行，取消后任务收尾。 |
| MCP | stdio/HTTP 工具发现、审批和结果回灌；故障服务不影响其他服务，退出后子进程与会话被关闭。 |

完整构建、全量测试、GUI 和打包等重型操作遵循当前资源与云端授权规则；不得以本机内存充足替代云端优先要求。

## GitHub Actions

以下按当前工作树的工作流定义描述；每次修改工作流后应以 GitHub Actions 的实际运行结果为准。实际 token 权限、fork PR 的密钥可用性和仓库设置取决于 GitHub 环境；运行或启用前应检查目标、权限、额度以及可能外发的数据。依赖安装会访问包注册表，artifact 上传会向 GitHub 保存所列文件。

| 工作流 | 触发与主要动作 | 凭据、外发和写入 |
|---|---|---|
| [Check](../.github/workflows/check.yml) | push 到 `master` 或 `desktop/**`、所有 PR、手动；三平台执行 `npm run check` | 未声明模型 secrets 或显式写权限。 |
| [Linux desktop](../.github/workflows/desktop.yml) | push 到 `desktop/**`、所有 PR、手动；模拟服务冒烟、打包及包启动 | 未调用真实模型；上传 Linux 打包产物和截图 artifact。 |
| [E2E LLM](../.github/workflows/e2e.yml) | 手动；可选择供应商和模型，`__list__` 只列模型 | 使用所选 `OPENROUTER_LLM_API_KEY` 或 `GROQ_LLM_API_KEY`，模型来自输入或对应 `OPENROUTER_MODEL` / `GROQ_MODEL` vars；会向供应商发送请求。 |
| [Benchmark](../.github/workflows/benchmark.yml) | 每日定时或手动；任务可筛选 | 使用对应供应商 secret 和 model var 或手动模型，向供应商发送任务；`contents: read`、`issues: write`。失败且满足定时或手动报告条件时可创建 issue，有运行 ID 时上传结果 artifact。 |
| [Benchmark Verify](../.github/workflows/benchmark-verify.yml) | 每日定时、手动、目标为 `master` 的 PR；PR 从正文中的 `#编号` 查找符合条件的开放 benchmark issue 并选择任务，无任务时跳过模型配置和运行 | PR 选择 OpenRouter，其他事件按供应商选择；使用相应 secret 和 model var，选中任务时向供应商发送请求。声明 `contents: read`、`issues: write`；非 PR 事件在选中任务时记录验证开始，并仅在默认分支且有运行 ID 时执行 issue 关闭检查；有运行 ID 时上传结果 artifact。PR 来源、权限或缺失密钥可能使步骤不可用或失败。 |
| [Auto Improve](../.github/workflows/auto-improve.yml) | 手动输入 issue 编号，构建后运行自动修复脚本 | 根据 `AUTO_IMPROVE_PROVIDER` 选择供应商 secret，模型由 `AUTO_IMPROVE_MODEL` 或 `OPENROUTER_MODEL` 指定；会向供应商发送任务和工作区上下文。声明 `contents: write`、`issues: read`、`pull-requests: write`，脚本可能修改仓库和创建 PR。 |

PR 的正文关联 issue 可能触发 Benchmark Verify 的外部模型调用；当前工作流将 issue 写入限定于非 PR 事件，并要求验证结果与 issue、任务、模型和供应商精确匹配后才允许关闭。模型发送的数据取决于实际测试任务和脚本，不能仅凭此表认定没有敏感内容。工作流、配置或行为变更应同步审查文档和示例，并在 PR 中记录未验证项。
