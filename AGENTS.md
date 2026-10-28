# Bitori 仓库工作约定

使用中文交流，源码解释性注释使用中文。Bitori 当前是 TypeScript/Node.js 24 跨平台终端助手，并提供 Linux Electron 桌面端初版；运行状态需单独验证。先阅读 [产品与路线图](docs/product.md)、[现有架构](docs/architecture.md) 和 [开发流程](docs/development.md)，以源码和测试确认具体行为。

修改时保持模型协议、工具权限、工作区路径、会话持久化和敏感数据处理的边界。Windows 使用 PowerShell，Linux/macOS 使用 bash；涉及跨平台行为时考虑三平台。不要提交真实密钥、日志、trace 或用户会话数据。配置、行为或工作流改变时同步更新对应文档；历史可由 Git 查阅。

按改动选择定向验证，必要时运行 `npm run check`；真实端点与平台验收须单独记录，未执行的检查如实报告。执行前遵循当前环境与用户提供的资源、云服务和权限约束。
