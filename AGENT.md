# Bitori 项目约束

Bitori 是一个使用 TypeScript 实现的跨平台终端 AI 对话助手，支持 Windows、Linux 和 macOS；命令执行在 Windows 使用 PowerShell，在其他平台使用 bash。

## 语言

- 使用中文交流。
- 源码中的解释性注释使用中文。

## 状态留痕

- 项目使用 `sNN` 标记每次可追溯状态；当前状态为 `s14`。
- 课程入口为 `docs/learning/README.md`。每个状态的教学讲义、实现快照与设计决策合并保存在 `docs/learning/lessons/NN.md`，已有课次文件不得删除。
- 源码中的解释性注释必须以对应状态标签开头，例如 `// [s01] ...`、`/** [s01] ... */`。
- 源码保持干净：被替换的旧实现不再以块注释保留，历史实现与设计取舍记录在对应课次的 `docs/learning/lessons/NN.md`「实现快照与设计决策」小节中。
- 不得为了留痕而保留真实密钥、令牌或其他敏感数据。状态留痕完成后仍须保证源码可编译、lint 与测试通过。

## 当前阶段

- s03 以独立 `AgentRunner` 持续执行“模型 → 工具 → 结果回写”；`/plan`/`/do` 切换 PLAN/DO 模式，中断后只恢复现场，不自动续跑。
- s04 系统提示由七个固定模块按优先级拼装并接环境信息；稳定模块与工具定义走 Anthropic 显式缓存断点。
- s05 以黑名单、真实路径沙箱、三层规则、权限档位和人在回路组成统一权限管线。
- s06 启动时从用户级与项目级配置发现 MCP Server，经 stdio 或 Streamable HTTP 握手并把远端工具适配进统一注册中心。
- s07 引入工具结果落盘预算、自动全量摘要、手动 `/compact`/`/c` 和压缩熔断恢复，通过 `context_window` 配置控制上下文预算。
- s08 支持指令文件 `@include` 展开、四类长期记忆提取和 `MEMORY.md` 轻量索引。
- s09 提供统一 Slash Command 注册表、别名补全、Markdown prompt 命令与使用统计。
- s10 提供 frontmatter 技能包、用户级/项目级两级加载热更新与 ActiveSkills 环境注入。
- s11 提供 15 个生命周期 Hook 事件、条件表达式、command/prompt/http 动作与 `pre_tool_use` 拦截。
- s12 提供内置 SubAgent 角色（plan/explore/general-purpose）、三级加载、多层工具过滤与后台任务通知。
- s13 提供 Worktree 安全 slug、纯文件系统 HEAD 读取、快速恢复、创建后设置、变更保护与清理。
- s14 提供团队花名册、成员文件邮箱、`wx` 文件锁、JSONL 游标恢复与进度状态。

## 验证

开发完成后先运行 `npm run check`。人工端到端验收在本机默认终端执行：启动 Bitori、发送真实对话、观察流式输出和取消/恢复行为，并按 `checklist.md` 逐项记录真实结果。

2026-08-23 已完成真实 DeepSeek Anthropic 兼容端点验收（s03）。GitHub Actions 在 ubuntu-latest、windows-latest 和 macos-latest 三平台执行完整 `npm run check`。官方三个原生供应商端点的分别实测仍是可选的完整供应商矩阵验收。
