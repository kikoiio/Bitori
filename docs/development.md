# 开发

## 命令与验证

需要 Node.js 24 和 npm。安装与启动见[项目 README](../README.md)，连接参数见[配置说明](configuration.md)。

| 命令 | 用途 |
|---|---|
| `npm run dev` | 源码启动终端界面 |
| `npm run build` / `npm start` | 编译至 dist，再启动编译入口 |
| `npm run desktop` | 构建并启动 Linux Electron 桌面 |
| `npm run desktop:package` | 构建 AppImage 和 deb |
| `npm run typecheck` / `npm run lint` | 类型与静态检查 |
| `npm test` | 先构建，再运行 Vitest |
| `npm run check` | 类型、lint、测试、构建完整检查 |
| `npm run test:tui:cursor:pty` | Linux PTY 检查 ASCII/CJK 输入后的 ANSI 光标行列，不验证像素外观 |

存储集成测试使用 `dist/storage/worker.js`，必须基于当前源码构建。[Check workflow](../.github/workflows/check.yml) 覆盖 Ubuntu、Windows、macOS；[桌面 workflow](../.github/workflows/desktop.yml) 覆盖 Linux 开发版及打包 smoke。重型构建、GUI、容器和大规模评测优先使用获授权的云端资源，本机按 MemAvailable、换页及 memory PSI 控制负载。

## 代码导航

```mermaid
flowchart LR
  CLI[CLI/TUI] --> Runtime[app/runtime]
  Desktop[Electron] --> Runtime
  Runtime --> Chat[chat: 会话与恢复]
  Chat --> Agent[agent: 模型与工具循环]
  Chat --> Storage[storage: SQLite worker]
  Agent --> Providers[providers: 协议适配]
  Agent --> Tools[tools: 权限与执行]
  Agent --> Trace[trace: 调用记录]
```

| 目录 | 职责 |
|---|---|
| `src/bin`、`src/cli`、`src/tui`、`src/desktop` | 参数、子命令、Ink/React 终端和 Linux Electron 界面 |
| `src/app`、`src/chat`、`src/agent` | 共用运行时、会话状态与恢复、流式收集、工具调度 |
| `src/providers` | Anthropic、OpenAI Chat/Responses、Qoder 协议；提供 items 时优先使用有序上下文，未提供才回退 messages |
| `src/tools`、`src/mcp` | 本地工具、路径与权限、快照撤销、MCP 发现与传输 |
| `src/storage`、`src/trace`、`src/usage` | SQLite worker 与数据库迁移、脱敏追踪、用量统计 |
| `src/prompt`、`src/compact`、`src/memory` | 提示组装、上下文压缩与记忆 |
| `src/skills`、`src/commands`、`src/hooks`、`src/subagents`、`src/teams`、`src/worktree` | 可加载扩展与协作工具 |
| `tests`、`evaluation` | 单元/集成/TUI/验收测试，可选基准与 RSI 控制面 |

桌面业务逻辑在主进程，渲染进程通过 preload 的受限 IPC 访问共用控制器；安全边界见[配置与安全](configuration.md#安全边界)。Qoder 关闭服务端内置工具，仅执行本地 custom tools；busy 时中断旧 turn、切换会话并发送完整转录，断流支持 Last-Event-ID 续读。

## 真实模型与评测

真实端点调用可能计费，必须单独授权并显式开启，例如：

```sh
BITORI_E2E_PROVIDERS=1 BITORI_E2E_PROTOCOL=qoder npm run test:e2e:providers
```

脚本读取用户 `.env`；省略协议时自动推断，`BITORI_E2E_PRESET=image` 限一次聊天调用。输出写入忽略入库的 `evaluation/results/e2e-providers/`，包含被测提交与工作树状态。[E2E workflow](../.github/workflows/e2e.yml) 使用仓库模型配置，上传脱敏证据；token/credits 阈值是运行后判定，不是请求硬上限。

RSI 和 SWE-bench Lite 是可选实验，当前没有后台定时运行，SWE-bench 扩跑暂停。后续运行须明确服务、凭据、发送数据范围和预算，历史授权不自动延续。

- [RSI workflow](../.github/workflows/rsi.yml) 仅手动触发，配置见 [smoke.json](../evaluation/RSI/smoke.json)：单题、单候选，90 分钟、100 次请求、2,000,000 tokens，每请求最多输出 32,000 tokens。候选在隔离容器执行，只持有短期令牌，真实密钥留在可信转发器；verifier 不写 Git、不授权合并，smoke 结论不作为合并依据。需从已审阅的默认分支触发；分支检查本身不是密钥信任边界。
- [SWE-bench workflow](../.github/workflows/swe-bench-lite.yml) 仅覆盖 23 道开发题，并非正式 300 题；公开任务发给所配模型，容器执行模型命令，尚无总 token 或美元硬上限，扩跑前需另定预算。

## 验收记录

既有产品待办已关闭。提交 `30e48d6` 的三平台 [Check](https://github.com/kikoiio/Bitori/actions/runs/41885899633)、Linux 开发版/AppImage/解包 deb 的 [smoke](https://github.com/kikoiio/Bitori/actions/runs/41770535976) 已通过；PTY 与用户 Ptyxis 截图完成光标验收。历史结果不代替后续变更的检查。

图片功能已按用户确认通过验收，识别能力依赖 VLM；[端点单次实测](https://github.com/kikoiio/Bitori/actions/runs/41826598229) 连接正常但未识别图片。[RSI 最近复验](https://github.com/kikoiio/Bitori/actions/runs/41838378031) 的基线已解决任务、轨迹完整，终态 no_candidate，未产出改进候选；workflow 因该终态返回 1，不属于改进通过。旧版本 SWE-bench 的 23 题没有 resolved，不代表当前版本成绩。

## 生成文件

`dist/`、`out/`、`evaluation/results/`、`.tmp/` 和工具缓存不入库；对应进程退出后可清理，构建输出可重新生成。项目 `.bitori/` 是配置与数据，不能整体当缓存处理。旧日志、决策和结果保留在 Git 历史，CI artifact 按保留期过期，需要长期留存时应提前归档。

下载、解包、重型工具缓存使用项目 `.tmp/`，先建目录，再设置 `TMPDIR="$PWD/.tmp"`，避免占用 `/tmp` 的 tmpfs 配额。Qoder 录制和脱敏脚本默认使用 `.tmp/qoder-capture`；真实录制需另行授权，脱敏后再更新协议 fixtures。
