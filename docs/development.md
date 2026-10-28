# 开发、测试与发布

## 本地开发

使用 Node.js 24 和 npm，在仓库根目录执行 `npm ci` 后，以 `npm run dev -- --profile <name>` 启动；配置见 [README](../README.md#配置)。`npm run build` 输出 `dist/`，`npm start` 运行编译结果。生成目录与本地密钥不应提交。开发中的 Electron 入口为 `npm run desktop`；`npm run desktop:package` 配置构建 Linux AppImage 和 deb。两者均需 Electron 依赖、图形环境及适当资源；启动后须选择并信任工作区。

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

[Linux 桌面工作流](../.github/workflows/desktop.yml) 在 Linux 图形环境中运行模拟服务的聊天、审批及会话测试，并构建和启动桌面包；不调用真实模型。

[Check 工作流](../.github/workflows/check.yml) 在向 `master` 推送、PR 和手动触发时于 Ubuntu、Windows、macOS 运行 `npm run check`。E2E 工作流手动运行并依赖仓库 secrets/vars；benchmark 有定时和手动任务，可能访问供应商、创建或关闭 issue；auto-improve 手动运行并可写入仓库和 PR。启用这些工作流前应核实凭据、权限、配额及数据外发范围。

## 发布现状与准备

`package.json` 标记 `private: true`，版本为 `0.1.0`；仓库配置了 Linux 桌面打包脚本，但没有自动发布流水线；Linux CI 已构建 AppImage 和 deb，并验证解包程序启动；安装流程与具体发行版兼容性需另行验收。当前可从源码构建并使用 `npm link`，不应将其描述为已有公开包。准备正式发布时，维护者应确认版本和变更记录、完成适用平台和真实端点验收、审查权限与敏感数据，再确定分发方式和发布流程；实际发布前另行确认目标与授权。
