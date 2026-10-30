# Bitori

本地软件工作区里的 coding agent。在终端和 Linux 桌面里对话、阅读和修改项目、查看工具调用，并在有副作用前按权限规则确认；会话保存在本机。

需要 Node.js 24。复制 [`config.example.yaml`](config.example.yaml) 与 [`.env.example`](.env.example)，填入模型和密钥后：

```sh
npm ci
npm run dev -- --profile <name>
```

产品意图、当前架构、配置和开发说明见 [文档索引](docs/README.md)。
