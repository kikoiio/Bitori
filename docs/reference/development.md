# 开发与测试

## 文档维护

项目意图、当前架构、执行计划和查阅资料分别维护，入口见 [文档索引](../README.md)。普通文档使用小写英文主题名，多词使用连字符；文档变化时同步更新索引。历史工作由 Git 保存。

## 本地开发

使用 Node.js 24 和 npm，在仓库根目录执行 `npm ci` 后，在 `~/.bitori/.env` 填一组 `<前缀>_API_KEY`/`_BASE_URL`/`_MODEL`（自动派生 profile；模板默认使用 `LLM_*`），再以 `npm run dev` 启动（多 profile 时加 `--profile <name>`；`bitori doctor` 可逐 profile 验证）；配置见 [配置与扩展](configuration.md)。`npm run build` 输出 `dist/`，`npm start` 运行编译后的终端入口。生成目录与本地密钥不应提交。

仓库用 `.gitattributes` 固定所有文本文件以 LF 检出。Windows 上若被转成 CRLF，源码里的 `\n` 转义与仓库里的实体文件会不一致，录制夹具的 SSE 分帧也会失效；改动后请确认 `git ls-files --eol` 全为 `i/lf w/lf`。

Linux Electron 日常迭代用 `npm run desktop`（开发入口带 `--disable-gpu --no-sandbox`，不把 `chrome-sandbox` 设为 root SUID）。`npm run desktop:package` 把安装形态写到 `out/desktop/`（`linux-unpacked`、AppImage、deb），供测试使用，配置禁止 publish。两者均需 Electron 依赖、图形环境及适当资源；启动后须选择并信任工作区。

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

`npm test` 的 `pretest` 会先构建；`npm run check` 包含 `npm test` 和再次构建。Check 中的终端 UI 测试使用模拟终端，不会启动 CLI 做交互验收。自动测试使用模拟客户端、临时 SQLite 或本地服务；真实模型验收依赖凭据、网络及供应商配额，结果应单独记录，不能由模拟测试推断。

真实 Provider 端到端（会产生费用，必须显式开启）：

```sh
BITORI_E2E_PROVIDERS=1 BITORI_E2E_PROTOCOL=qoder npm run test:e2e:providers
BITORI_E2E_PROVIDERS=1 BITORI_E2E_PROTOCOL=openai-chat npm run test:e2e:providers   # 需要 OPENROUTER_API_KEY 或 OPENAI_* 凭据
```

`BITORI_E2E_PROTOCOL` 可以省略：此时按 `LLM_BASE_URL` 与密钥形状推断方言，与 `~/.bitori/config.yaml` 的规则一致；凭据仍从 `~/.bitori/.env` 读取。

脚本在临时工作区跑“读取 → pwd → 编辑 → 校验 → 回答”的完整编码任务，断言工具链、diff、回复与用量（tokens 或 credits 至少其一真实非零），证据写入 `evaluation/results/e2e-providers/`（自动脱敏，日志不打印密钥）。`BITORI_E2E_PRESET=fix-test|add-test|refactor` 另跑「修复失效测试 / 补测试 / 小重构」三类真实编码场景（2026-11-01 全部用 Qoder 通过）。旧的 `tests/acceptance/e2e-openrouter.ts` 保留可用。

历史真实闭环证据：Qoder 见 `2026-11-01-qoder*.json`（credits 计费），OpenAI 兼容协议见 `2026-11-03-openai-chat.json`（Groq `openai/gpt-oss-120b`，token 计费），Anthropic 兼容网关见 `2026-11-03-anthropic.json`。这些文件没有运行提交 SHA。验收脚本现写入 `commitSha` 与 `workingTreeClean`；本地 SHA 只标识 Git HEAD，必须同时确认工作树为 clean 才能代表完整被测代码。没有本地凭据时，可经授权手动运行 E2E 工作流：它读取 `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`，真实发送请求，并只上传本次运行的证据 JSON artifact 保留 7 天；下载后按同样格式归档到 `evaluation/results/e2e-providers/`。

Qoder 协议事件 fixture 来自真实录制：`npx tsx tests/acceptance/qoder-capture.ts --out /tmp/qoder-capture`（录制 busy 409、版本冲突 409、Last-Event-ID 重连、内置工具 requires_action、credits 用量等），再 `npx tsx tests/acceptance/sanitize-qoder-capture.ts` 脱敏输出到 `tests/fixtures/streams/qoder/`。`tests/integration/qoder-events.test.ts` 逐帧回放这些真实事件。

桌面冒烟由 GitHub Actions + Xvfb 顺序执行，覆盖四种审批选择、一次/会话/永久授权边界、diff/撤销、模型列表和会话管理。工作流还会启动 `linux-unpacked`、AppImage（`--appimage-extract-and-run`）及解包 deb 中的应用二进制；结果和截图 artifact 保留 7 天。当前工作流新增的打包启动步骤尚未有成功运行记录，需在 GitHub 手动触发后验收。脚本支持 `BITORI_PACKAGED_BINARY` 指定二进制和 `BITORI_SCREENSHOT_PREFIX` 区分截图；测试 HOME 中不得已有 `~/.bitori`。

诊断与信任：`node dist/bin/bitori.js doctor [--profile name] [--json]` 输出配置/凭据/工作区/连通性/模型列表（不含密钥）；`bitori trust [path] [--revoke]` 管理工作区信任清单。

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
| 终端 | TUI 模拟终端测试；CLI 交互与光标观感 | 自动测试在 Check；交互观感需用户目标终端验收 | 自动测试随 Check；真实终端按环境验收 |
| 桌面未打包 | 开发入口会话、审批、工作区信任 | GitHub Actions + Xvfb | PR / `desktop/**` / 手动；master 需手动触发 |
| 桌面包 | `linux-unpacked`、AppImage、解包 deb 启动 | GitHub Actions + Xvfb；截图与安装包 artifact 留 7 天 | 新步骤待本轮手动 workflow 验收 |
| 真实模型 | Provider 端到端（Qoder/OpenAI 兼容等）+ OpenRouter/Groq | 本机 `BITORI_E2E_PROVIDERS=1 npm run test:e2e:providers`；旧的手动 `e2e.yml` | 明确授权并确认预算后 |
| SWE-bench Lite 开发集 | 单题或 23 题开发集；最近 23 题结果为 8 个 agent 错误、7 个未解决、8 个环境错误 | GitHub Actions + Docker；每题串行 | 需选 Provider/model、运行范围和预算后授权 |
| RSI smoke | 受控单题 RSI 实验 | 当前暂停 | 单独恢复立项并明确授权、数据范围和预算后 |

## GitHub Actions

以下按当前工作树的工作流定义描述；每次修改工作流后应以 GitHub Actions 的实际运行结果为准。实际 token 权限、fork PR 的密钥可用性和仓库设置取决于 GitHub 环境；运行或启用前应检查目标、权限、额度以及可能外发的数据。依赖安装会访问包注册表，artifact 上传会向 GitHub 保存所列文件。

| 工作流 | 触发与主要动作 | 凭据、外发和写入 |
|---|---|---|
| [Check](../../.github/workflows/check.yml) | push 到 `master` 或 `desktop/**`、所有 PR、手动；三平台执行 `npm run check` | 未声明模型 secrets 或显式写权限。 |
| [Linux desktop](../../.github/workflows/desktop.yml) | push 到 `desktop/**`、所有 PR、手动；模拟服务冒烟并逐一启动 `linux-unpacked`、AppImage、解包 deb | 未调用真实模型；上传 7 天 AppImage/deb 与截图 artifact。当前改动在 master 上需手动触发；新增步骤尚无成功运行记录。 |
| [E2E LLM](../../.github/workflows/e2e.yml) | 手动；可选择接口方言、覆盖模型和事后用量阈值 | 统一读 `secrets.LLM_API_KEY` 与 `vars.LLM_BASE_URL`、`vars.LLM_MODEL`；先跑 `bitori doctor` 用真实凭据验证连通性与模型列表，再跑统一验收脚本 `npm run test:e2e:providers`。token 阈值可选 25k/50k/100k/150k，Qoder 可选 1/2/5 credits；脚本运行后才检查用量，不会阻止请求超额，实际费用可能高于阈值。需另确认供应商账户级费用限额；只上传本次运行的证据 JSON 并保留 7 天。 |
| [SWE-bench Lite development](../../.github/workflows/swe-bench-lite.yml) | 手动运行单题或 23 题开发集；每题隔离运行，`max-parallel: 1` | 使用所选模型供应商的 secret 和 model var；向供应商发送公开任务内容。容器中的 agent 可访问容器凭据与网络；上传 result/trajectory/diagnosis/patch/artifact 白名单与汇总，保留 7 天。全量运行没有统一 token 或美元费用上限。 |
| [RSI smoke](../../.github/workflows/rsi.yml) | 当前暂停；恢复后手动运行受控单题 RSI smoke；默认分支代码、完整基线 SHA 和确认短语 | 使用 `XUNFEI_LLM_API_KEY`、`XUNFEI_OPENAI_RESPONSE_URL` 和 `XUNFEI_MODEL`；向讯飞发送第 0 题内容，上传报告、账本、诊断、假设、补丁、检查、比较、验证和轨迹，不上传 gold、凭据、worktree 或构建产物。 |

模型发送的数据取决于实际测试任务和脚本，不能仅凭此表认定没有敏感内容。工作流、配置或行为变更应同步审查文档和示例，并在 PR 中记录未验证项。
