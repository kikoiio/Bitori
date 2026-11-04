# Bitori

Bitori 是在本地工作区中运行的 AI 编码助手，提供跨平台终端 TUI 和 Linux 桌面界面。模型可读取文件、提出修改并调用工具；需要审批的操作会先显示实际参数。

本地图片、版本化会话 JSON 交换和中断恢复已完成实现。本轮整合的产品提交 `12335b0` 的三平台 Check 与 Linux 桌面/安装包 smoke 均通过；真实图片请求中，已配置模型称未收到图像，因此该模型/网关组合未通过图像识别验收。验证细节见 [开发与测试](docs/reference/development.md) 与 [PLAN.md](PLAN.md)。云同步已取消；RSI 与 SWE-bench Lite 评测暂停。桌面图形应用当前只支持 Linux。

## 首次启动

源码运行需要 Node.js 24 和 npm。在仓库根目录安装依赖后启动终端界面：

```sh
npm ci
npm run dev
```

首次运行会创建 `~/.bitori/config.yaml` 和 `~/.bitori/.env`，缺少连接参数时会提示填写后退出。在 `.env` 中填写供应商提供的连接信息，变量名为 `LLM_API_KEY`、`LLM_BASE_URL` 和 `LLM_MODEL`；不要将该文件提交到仓库。已有完整进程环境变量时可直接加载配置。协议识别、多配置及扩展规则见 [配置参考](docs/reference/configuration.md)。

配置完成后检查连接，再启动对话：

```sh
npm run dev -- doctor
npm run dev
```

多配置时可用 `npm run dev -- --profile <name>` 直接选择。`doctor` 会发送真实网络探测请求，报告凭据、协议、连通性和模型列表，不打印密钥。

## 在终端或桌面对话

TUI 使用当前目录作为工作区。输入任务后按 Enter 发送，生成期间按 Esc 取消。`/model` 切换配置或模型，`/new` 新建会话，`/sessions` 打开历史会话，`/help` 浏览命令。文本和待发送图片草稿按会话保存于当前界面内存，未发送草稿不会在退出后恢复。

Linux 桌面源码入口是 `npm run desktop`，该命令会先构建并准备 Electron。启动后在侧栏选择并信任工作区，再选择模型配置。Enter 发送，Shift+Enter 换行，停止按钮取消生成；侧栏可管理历史会话。工作区信任会允许加载项目配置、指令、记忆、skills、commands、agents、权限规则、MCP 和 Hook；确认前应审查仓库内容。

工具审批可选择仅本次、本会话、永久允许或拒绝。会话批准仅在当前进程中对当前聊天生效；永久规则写入项目 `.bitori/permissions.local.yaml`。启用 bypass 要在 `/permission bypass` 后一分钟内、同一聊天中再输入 `/permission bypass confirm`；切换聊天时立即清除。权限档位、规则优先级和限制见 [权限规则与审批](docs/reference/configuration.md#权限规则与审批)。

## 图片、会话交换与恢复

| 操作 | TUI | Linux 桌面 |
|---|---|---|
| 添加本地图片 | `/attach <path>`，可重复添加；`/attachments clear` 清除待发送图片 | 输入框旁的“图片”选择文件；“粘贴”读取剪贴板图片，也可在输入框粘贴图片 |
| 导出当前会话 | `/export <path>` | 侧栏“导出当前”选择保存路径 |
| 导入会话 | `/import <path>` | 侧栏“导入会话”选择 JSON 文件 |
| 确认恢复中断任务 | 根据提示输入 `/resume` | 在恢复提示中检查风险后点击继续按钮 |

图片支持 PNG、JPEG、GIF、WebP；每条消息最多 4 张，单张非空且不超过 4 MiB，合计不超过 8 MiB。宽高均不得超过 8192 像素，总像素不得超过 20,000,000。可只发送图片；终端显示文件名和类型，桌面提供预览和移除。实际模型必须支持图片，Qoder 当前拒绝图片输入；不会自动改成纯文本重发。详见 [图片附件](docs/reference/configuration.md#图片附件)。

会话交换使用带版本的 Bitori JSON，图片内容内嵌，最大 16 MiB。导入创建新会话，不覆盖原会话，也不执行归档中的工具。归档不包含配置和凭据字段，但消息、工具输出及图片仍可能含有秘密，分享前需检查。CLI 用法见 [会话导入与导出](docs/reference/configuration.md#会话导入与导出)。

重新打开会话时，交互界面会检查最近的进程中断回合。安全回合自动恢复；存在结果不确定的写入、命令或其他非只读工具时先请求确认。已完成工具结果作为上下文恢复，不由恢复机制直接重放。确认继续后模型仍可能提出新工具调用，适用当前审批规则。这不是对外部副作用“恰好执行一次”的保证。手动停止、失败或导入的回合不会自动续跑，`exec` 也不会自动恢复历史任务。

## 开发与限制

[文档索引](docs/README.md) 汇总配置、架构、安全与验收说明。本轮产品提交 `12335b0` 的三平台 Check [run 41770176066](https://github.com/kikoiio/Bitori/actions/runs/41770176066) 和 Linux 开发版、打包版、AppImage、deb smoke [run 41770535976](https://github.com/kikoiio/Bitori/actions/runs/41770535976) 全部通过；最终证据提交 `d681327` 的三平台 Check [run 41771262395](https://github.com/kikoiio/Bitori/actions/runs/41771262395) 也通过。真实终端光标视觉验收目前为 `INCONCLUSIVE`；Windows 和 macOS 桌面不在当前目标范围内。
