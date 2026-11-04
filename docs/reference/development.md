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

## 最近验证与未验收边界

截至 2026-11-04，最新记录的三平台完整 Check 是提交 `d681327` 的 [run 41771262395](https://github.com/kikoiio/Bitori/actions/runs/41771262395)，Ubuntu、Windows 和 macOS 均通过。Linux 桌面开发版及打包 smoke 在 [run 41770535976](https://github.com/kikoiio/Bitori/actions/runs/41770535976) 通过。它们早于本文档整理，不代表本次文档改动重新运行了产品检查。

当前已知的两项验收边界：

- [图片 Provider run 41768902090](https://github.com/kikoiio/Bitori/actions/runs/41768902090) 中，已配置的 Anthropic/DeepSeek 端点没有向模型呈现可识别的图片内容。应用适配器测试确认图片以 base64 image block 发送；单次实测无法区分模型能力与网关转发问题。该组合未通过图片识别验收。
- Linux 隔离 PTY 已验证 ASCII 与中文输入后的 ANSI 光标位置；用户提供的 Ptyxis 实际窗口截图显示提示区和文本末尾光标，像素验收完成。

图片端点仍未通过识别验收；Ptyxis 截图只确认了提示区和插入光标的实际显示。评测工作流及 RSI 状态见[评测参考](evaluation.md)。
