# 开发与验证

## 本地开发

项目使用 Node.js 24 和 npm。在仓库根目录安装依赖并启动终端界面：

```sh
npm ci
npm run dev
```

首次运行会创建 `~/.bitori/config.yaml` 和 `~/.bitori/.env`。在 `.env` 中填写 `LLM_API_KEY`、`LLM_BASE_URL` 和 `LLM_MODEL`，或配置完整的进程环境变量组。配置格式和协议选择见[配置参考](configuration.md)。

`npm run build` 生成 `dist/`，`npm start` 运行编译后的终端入口。Linux 桌面开发入口是 `npm run desktop`；它会构建并启动 Electron，需要图形环境。`npm run desktop:package` 生成 AppImage 与 deb 测试包。

## 自动检查

以下命令可按改动范围选择；列出命令不代表本次文档整理已运行这些检查：

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run check
```

`npm test` 会先运行构建；存储集成测试使用 `dist/storage/worker.js`，因此不能用旧构建结果代替当前源码。完整多平台检查由 [Check workflow](../../.github/workflows/check.yml) 执行。GUI、打包和大规模评测属于重型任务，遵循仓库资源规则并在获授权的 CI 中运行。

Linux TUI 的真实伪终端检查：

```sh
npm run test:tui:cursor:pty
```

该脚本会启动 Ink 输入组件，并检查 ASCII 与中文输入后的 ANSI 光标行列；它不验证终端窗口中的像素外观。

## 真实 Provider 验收

真实端到端请求会访问模型供应商并可能产生费用，须显式开启：

```sh
BITORI_E2E_PROVIDERS=1 BITORI_E2E_PROTOCOL=qoder npm run test:e2e:providers
BITORI_E2E_PROVIDERS=1 BITORI_E2E_PROTOCOL=openai-chat npm run test:e2e:providers
```

脚本从 `~/.bitori/.env` 读取凭据；省略 `BITORI_E2E_PROTOCOL` 时按配置推断协议。`BITORI_E2E_PRESET=image` 会发出一次图片请求。真实结果写入 `evaluation/results/e2e-providers/`，记录被测 commit 和工作树状态；历史记录不能代替当前版本的实测。GitHub E2E workflow 读取仓库配置并上传本次运行的脱敏 JSON，详见[工作流](../../.github/workflows/e2e.yml)。

## 已有验收证据

清理前的提交 `30e48d6` 已通过 Ubuntu、Windows 和 macOS 的完整 [Check](https://github.com/kikoiio/Bitori/actions/runs/41885899633)。Linux 桌面开发版、AppImage 与解包 deb 的 [smoke](https://github.com/kikoiio/Bitori/actions/runs/41770535976) 通过。Linux PTY 已验证 ASCII、中文输入后的 ANSI 光标位置，用户提供的 Ptyxis 截图完成提示区与插入光标的像素验收。这些历史结果不代替后续代码变更的验证。

图片功能按用户确认通过验收：识别依赖所配模型具备 VLM 能力。[单次端点实测](https://github.com/kikoiio/Bitori/actions/runs/41826598229) 连接正常，但未识别测试图片；该记录不证明此端点具备图片识别能力。

既有产品待办已关闭。RSI 复验已结束且无改进候选；SWE-bench Lite 扩跑保持暂停，见[评测参考](evaluation.md)。

## 生成文件与缓存

`dist/` 是编译输出，`out/` 是桌面打包输出；可在对应进程退出后删除，由构建命令重新生成。`evaluation/results/` 保存本次评测输出，全部忽略入库；长期验收证据通过文档中的 CI 链接引用。旧执行日志可从 Git 历史查看。

本机下载、解包与重型工具缓存应使用项目内 `.tmp/`，例如 `TMPDIR="$PWD/.tmp"`，使用前先创建目录，避免占用 `/tmp` 的 tmpfs 配额。Qoder 录制及脱敏脚本默认使用 `.tmp/qoder-capture`；真实录制仍需单独授权，脱敏后才可更新 `tests/fixtures/streams/qoder/`。
