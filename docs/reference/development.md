# 开发与测试

## 文档维护

项目意图、当前架构、执行计划和查阅资料分别维护，入口见 [文档索引](../README.md)。普通文档使用小写英文主题名，多词使用连字符；文档变化时同步更新索引。历史工作由 Git 保存。

## 本地开发

使用 Node.js 24 和 npm，在仓库根目录执行 `npm ci` 后，在 `~/.bitori/.env` 填一组 `<前缀>_API_KEY`/`_BASE_URL`/`_MODEL`（自动派生 profile；模板默认使用 `LLM_*`），再以 `npm run dev` 启动（多 profile 时加 `-- --profile <name>`；`bitori doctor` 可逐 profile 验证）；配置见 [配置与扩展](configuration.md)。`npm run build` 输出 `dist/`，`npm start` 运行编译后的终端入口。生成目录与本地密钥不应提交。

仓库用 `.gitattributes` 固定所有文本文件以 LF 检出。Windows 上若被转成 CRLF，源码里的 `\n` 转义与仓库里的实体文件会不一致，录制夹具的 SSE 分帧也会失效；改动后请确认 `git ls-files --eol` 全为 `i/lf w/lf`。

Linux Electron 日常迭代用 `npm run desktop`（开发入口带 `--disable-gpu --no-sandbox`，不把 `chrome-sandbox` 设为 root SUID）。`npm run desktop:package` 把安装形态写到 `out/desktop/`（`linux-unpacked`、AppImage、deb），供测试使用，配置禁止 publish。两者均需 Electron 依赖、图形环境及适当资源；启动后须选择并信任工作区。

## 验证

根据改动选择相关测试，轻量改动可选择定向静态检查。下列是可用命令，不表示本轮已执行；完整检查和覆盖率测试应放到获授权的云端 CI：

```sh
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm run build
npm run check
node dist/bin/bitori.js --help
```

`npm test` 的 `pretest` 会先构建；`npm run check` 包含 `npm test` 和再次构建。直接调用 `npx vitest run <test-path>` 不会运行 npm 的 `pretest`。存储集成测试会启动 `dist/storage/worker.js`，必须先在同一份代码上构建，不能用旧 `dist/` 代表当前源码。Check 中的终端 UI 测试使用模拟终端，不会启动 CLI 做交互验收。自动测试使用模拟客户端、临时 SQLite 或本地服务；真实模型验收依赖凭据、网络及供应商配额，结果应单独记录，不能由模拟测试推断。

真实 Provider 端到端（会产生费用，必须显式开启）：

```sh
BITORI_E2E_PROVIDERS=1 BITORI_E2E_PROTOCOL=qoder npm run test:e2e:providers
BITORI_E2E_PROVIDERS=1 BITORI_E2E_PROTOCOL=openai-chat npm run test:e2e:providers   # 需要 OPENROUTER_API_KEY 或 OPENAI_* 凭据
```

`BITORI_E2E_PROTOCOL` 可以省略：此时按 `LLM_BASE_URL` 与密钥形状推断方言，与 `~/.bitori/config.yaml` 的规则一致；凭据仍从 `~/.bitori/.env` 读取。

脚本在临时工作区跑“读取 → pwd → 编辑 → 校验 → 回答”的完整编码任务，断言工具链、diff、回复与用量（tokens 或 credits 至少其一真实非零），证据写入 `evaluation/results/e2e-providers/`（自动脱敏，日志不打印密钥）。`BITORI_E2E_PRESET=fix-test|add-test|refactor` 另跑「修复失效测试 / 补测试 / 小重构」三类真实编码场景（2026-11-01 全部用 Qoder 通过）。旧的 `tests/acceptance/e2e-openrouter.ts` 保留可用。

历史真实闭环证据：Qoder 见 `2026-11-01-qoder*.json`（credits 计费），OpenAI 兼容协议见 `2026-11-03-openai-chat.json`（Groq `openai/gpt-oss-120b`，token 计费），Anthropic 兼容网关见 `2026-11-03-anthropic.json`。这些文件没有运行提交 SHA。验收脚本现写入 `commitSha` 与 `workingTreeClean`；本地 SHA 只标识 Git HEAD，必须同时确认工作树为 clean 才能代表完整被测代码。没有本地凭据时，可经授权手动运行 E2E 工作流：它读取 `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`，真实发送请求，并只上传本次运行的证据 JSON artifact 保留 7 天；下载后按同样格式归档到 `evaluation/results/e2e-providers/`。

Qoder 协议事件 fixture 来自真实录制：`npx tsx tests/acceptance/qoder-capture.ts --out .tmp/qoder-capture`（录制 busy 409、版本冲突 409、Last-Event-ID 重连、内置工具 requires_action、credits 用量等），再 `npx tsx tests/acceptance/sanitize-qoder-capture.ts` 脱敏输出到 `tests/fixtures/streams/qoder/`。`tests/integration/qoder-events.test.ts` 逐帧回放这些真实事件。

桌面冒烟由 GitHub Actions + Xvfb 顺序执行，覆盖四种审批选择、一次/会话/永久授权边界、diff/撤销、模型列表、会话管理、图片/归档入口和重命名期间 caret 稳定。工作流还会启动开发版、打包版、AppImage（通过 `APPIMAGE_EXTRACT_AND_RUN=1` 启动）及解包 deb 中的应用二进制；结果和截图 artifact 保留 7 天。提交 `f66f293` 的 [run 41680030634](https://github.com/kikoiio/Bitori/actions/runs/41680030634) 全部通过；只读查询确认 `desktop-packaged-linux`（236,896,325 bytes）和 `desktop-screenshots`（962,896 bytes）已上传，保留至 2026-11-10。脚本支持 `BITORI_PACKAGED_BINARY` 指定二进制和 `BITORI_SCREENSHOT_PREFIX` 区分截图；测试 HOME 中不得已有 `~/.bitori`。

诊断与信任：`node dist/bin/bitori.js doctor [--profile name] [--json]` 输出配置/凭据/工作区/连通性/模型列表（不含密钥）；`bitori trust [path] [--revoke]` 管理工作区信任清单。

## 本轮产品开发与验证状态

截至 2026-11-03，本地图片、版本化会话 JSON 和自动恢复已完成实现；RSI 暂停。提交 `f66f293` 的三平台完整 Check [run 41679968530](https://github.com/kikoiio/Bitori/actions/runs/41679968530) 全部通过；Linux 桌面 GUI/打包 smoke [run 41680030634](https://github.com/kikoiio/Bitori/actions/runs/41680030634) 全部通过，包含重命名输入保持 caret 选区。Ubuntu 完成类型检查、lint、构建及 111 个测试文件的 737 项测试；用户入口与限制见 [配置参考](configuration.md#图片附件)。

本轮产品代码由三平台 Check [run 41679968530](https://github.com/kikoiio/Bitori/actions/runs/41679968530) 和 Linux 桌面工作流 [run 41680030634](https://github.com/kikoiio/Bitori/actions/runs/41680030634) 验收通过。一个 Anthropic 兼容端点的历史真实文本工具任务不验收本轮图片能力；Qoder、OpenAI Chat 和 Anthropic 的早期证据未记录提交 SHA；OpenAI Responses 没有真实端点验收证据，不能把适配器单测当作真实端点成功。

Run 41679968530 在提交 `f66f293` 上完成三平台 `npm run check`，包括类型检查、lint、构建和全量 Vitest；Ubuntu 为 111 files / 737 tests。Linux desktop run 41680030634 通过开发版、安装包、AppImage 和 deb smoke，并已核实 artifact 上传。只改文档的后续提交仍由 GitHub Actions Check 验证，最终证据以 PLAN.md 为准。

| 本轮场景 | 需要确认的行为 |
|---|---|
| 图片 | 四种格式与大小边界、纯图片发送、跨会话草稿隔离、失败可重试、模型不支持时明确报错、trace 不持久化原始图片 |
| 会话归档 | 导出后导入保留可见消息与工具结果；图片内嵌；生成新 ID；无效引用或超限归档拒绝且不留下部分数据；已有文件不覆盖 |
| 自动恢复 | 持久化预算不倒退；已完成工具不直接重放；不确定副作用需确认；取消、导入与其他活动实例不自动续跑 |
| TUI 与桌面 | 命令与文件对话框入口、审批、默认模型恢复、会话切换及重命名草稿；桌面增加相应 smoke 覆盖 |

TUI 模拟测试覆盖光标行列、中文折行、流式更新、输入与取消，但不等于真实终端视觉验收。本机 Ptyxis 曾显示 Bitori 的可访问树，因截图能力受限且出现已有会话内容，未继续输入，光标视觉结论为 `INCONCLUSIVE`。当前桌面目标仅为 Linux；三平台 Check 通过不代表 Windows 或 macOS 桌面已支持。

## Ubuntu 资源与本机兜底

轻量只读检索和不冲突的编辑可并行。启动重型操作前由主执行者统一安排，检查 `free -h` 的 MemAvailable、`vmstat 1 5` 后续采样的换页速率及 `/proc/pressure/memory`；不能只凭 swap 使用率判断内存不足。还需检查容器的 cgroup 限额，并保留桌面余量。

本机 `/tmp` 是有用户配额的 tmpfs。下载、解包和缓存应把 `TMPDIR` 指向项目 `.tmp` 等根文件系统目录，操作前检查 `df -h /tmp`；磁盘余量不代表用户配额充足。不得擅自清理其他任务文件或结束其进程。

只有云端无法覆盖时才在本机跑 GUI。前置条件为 MemAvailable 至少 4 GiB 且内存 PSI 低，一次只启动一个实例。Electron 加 `--disable-gpu`；Wayland 会话下 Xvfb 演练还需清除 `WAYLAND_DISPLAY` 并加 `--ozone-platform=x11`，防止窗口出现在真实桌面。结束后清理本任务启动的临时进程。资源不足或环境不支持时应记录未验证原因。

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

默认用 GitHub Actions 短生命周期 runner。完整构建、全量测试、GUI、打包和容器任务一律优先云端免费资源；调用服务前须告知用途与所需权限，并沿用会话中已有授权。本机仅承担轻量定向检查，以及云端无法覆盖的真实终端交互。

| 层 | 测什么 | 在哪跑 | 何时 |
|---|---|---|---|
| Check | 类型、lint、单元/集成/TUI 测试、`dist/` 构建 | GitHub-hosted Ubuntu/Windows/macOS | 每个 PR 和 `master` |
| 终端 | TUI 模拟终端测试；CLI 交互与光标观感 | 自动测试在 Check；交互观感需用户目标终端验收 | 自动测试随 Check；真实终端按环境验收 |
| 桌面未打包 | 开发入口会话、审批、工作区信任、图片/归档、重命名 caret | GitHub Actions + Xvfb | 当前 `master` 的 run 41680030634 通过 |
| 桌面包 | 开发版、AppImage、解包 deb 启动 | GitHub Actions + Xvfb；截图与安装包 artifact 留 7 天 | run 41680030634 通过；artifact 已核实上传 |
| 真实模型 | Provider 端到端（Qoder/OpenAI 兼容等）+ OpenRouter/Groq | 获授权的手动 `e2e.yml`，或确需本地环境的定向脚本 | 明确授权并确认预算后 |
| SWE-bench Lite 开发集 | 单题或 23 题开发集；最近 23 题结果为 8 个 agent 错误、7 个未解决、8 个环境错误 | GitHub Actions + Docker；每题串行 | 需选 Provider/model、运行范围和预算后授权 |
| RSI smoke | 受控单题 RSI 实验 | 当前暂停 | 单独恢复立项并明确授权、数据范围和预算后 |

## GitHub Actions

以下按当前工作树的工作流定义描述；每次修改工作流后应以 GitHub Actions 的实际运行结果为准。实际 token 权限、fork PR 的密钥可用性和仓库设置取决于 GitHub 环境；运行或启用前应检查目标、权限、额度以及可能外发的数据。依赖安装会访问包注册表，artifact 上传会向 GitHub 保存所列文件。

| 工作流 | 触发与主要动作 | 凭据、外发和写入 |
|---|---|---|
| [Check](../../.github/workflows/check.yml) | push 到 `master` 或 `desktop/**`、所有 PR、手动；三平台执行 `npm run check` | 未声明模型 secrets 或显式写权限。 |
| [Linux desktop](../../.github/workflows/desktop.yml) | push 到 `desktop/**`、所有 PR、手动；模拟服务冒烟并逐一启动 `linux-unpacked`、AppImage、解包 deb | 未调用真实模型；上传 7 天 AppImage/deb 与截图 artifact。master 上需手动触发；本轮正在安排与最终产品提交一致的复验。 |
| [E2E LLM](../../.github/workflows/e2e.yml) | 手动；可选择接口方言、覆盖模型和事后用量阈值 | 统一读 `secrets.LLM_API_KEY` 与 `vars.LLM_BASE_URL`、`vars.LLM_MODEL`；先跑 `bitori doctor` 用真实凭据验证连通性与模型列表，再跑统一验收脚本 `npm run test:e2e:providers`。token 阈值可选 25k/50k/100k/150k，Qoder 可选 1/2/5 credits；脚本运行后才检查用量，不会阻止请求超额，实际费用可能高于阈值。需另确认供应商账户级费用限额；只上传本次运行的证据 JSON 并保留 7 天。 |
| [SWE-bench Lite development](../../.github/workflows/swe-bench-lite.yml) | 手动运行单题或 23 题开发集；每题隔离运行，`max-parallel: 1` | 使用所选模型供应商的 secret 和 model var；向供应商发送公开任务内容。容器中的 agent 可访问容器凭据与网络；上传 result/trajectory/diagnosis/patch/artifact 白名单与汇总，保留 7 天。全量运行没有统一 token 或美元费用上限。 |
| [RSI smoke](../../.github/workflows/rsi.yml) | 当前暂停；恢复后手动运行受控单题 RSI smoke；默认分支代码、完整基线 SHA 和确认短语 | 读取仓库通用 `LLM_API_KEY`、`LLM_BASE_URL` 和 `LLM_MODEL` 配置；向配置的 Provider 发送第 0 题内容，上传报告、账本、诊断、假设、补丁、检查、比较、验证和轨迹，不上传 gold、凭据、worktree 或构建产物。 |

模型发送的数据取决于实际测试任务和脚本，不能仅凭此表认定没有敏感内容。工作流、配置或行为变更应同步审查文档和示例，并在 PR 中记录未验证项。
