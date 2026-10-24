# Bitori 实战课程

本课程通过连续构建 Bitori 学习 TypeScript、终端 UI、模型协议、工具系统、Agent Loop、权限安全与 MCP 集成。课程以仓库真实源码为教材，每课完成一个可运行能力，并以自动测试和真实终端走查收尾。

## 课程原则

- 每课交付一个可验证能力，不引入为下一课才需要的基础设施。
- 先读现有代码，再写最小改动；改动必须落在课程指定的模块边界内。
- 所有解释性源码注释使用中文并带 `[sNN]` 状态标签，符合 `AGENT.md` 的状态留痕规则。
- 自动测试是每课的第一道门槛；涉及 Windows Terminal、真实模型或真实 MCP Server 的项目，在对应环境完成人工验收并记录到该课 `checklist.md`。
- 课程不要求外部 AI 生成代码。遇到不确定的实现，先读测试和相邻模块，再写最小实现。

## 学习路径

| 课次 | 主题 | 能力结果 |
|---|---|---|
| [01](lessons/01.md) | 项目与全屏聊天客户端 | Node 24 + Windows 全屏 TUI，三协议流式对话、多会话与 SQLite 持久化 |
| [02](lessons/02.md) | 统一工具系统 | 六个内置工具、真实路径边界、审批、执行、持久化与协议适配 |
| [03](lessons/03.md) | Agent Loop 与 Plan Mode | 自主多轮执行、取消恢复、20 轮上限、Plan/Do 模式与用量持久化 |
| [04](lessons/04.md) | 系统提示与缓存通道 | 七模块系统提示、环境冻结、请求级提醒与 Anthropic 缓存断点 |
| [05](lessons/05.md) | 五层权限系统 | 黑名单、路径沙箱、三层规则、三档权限与人在回路 |
| [06](lessons/06.md) | MCP 工具客户端 | stdio/HTTP MCP Server 发现、工具适配、故障隔离与统一关闭 |
| [07](lessons/07.md) | 上下文管理 | 工具结果落盘预算、自动全量摘要、手动 `/compact` 与压缩熔断 |
| [08](lessons/08.md) | 跨会话记忆 | 指令文件 @include 展开、四类长期记忆、MEMORY.md 轻量索引 |
| [09](lessons/09.md) | Slash Command | 统一命令注册表、别名补全、Markdown prompt 命令与使用统计 |
| [10](lessons/10.md) | Skill 系统 | frontmatter 技能包、两级加载热更新、ActiveSkills 环境注入 |
| [11](lessons/11.md) | Hook 系统 | 15 个生命周期事件、条件表达式、四类动作与工具前拦截 |
| [12](lessons/12.md) | SubAgent | 内置角色定义、三级加载、多层工具过滤、后台任务通知 |
| [13](lessons/13.md) | Worktree | 安全 slug、快速恢复、创建后设置、变更保护与清理 |
| [14](lessons/14.md) | Agent Teams | 团队花名册、成员文件邮箱、锁与游标恢复、进度状态 |

每课文件开头列出前置课次、预计时长和所需环境。完成顺序固定；跳课前至少通读前一课的 `Project_Guide/sNN.md`。

## 文档地图

- 课程总览与学习路径：本文件。
- 每课讲义：`lessons/NN.md`。
- 阶段实现导读：`../../Project_Guide/sNN.md`。

## 验证基线

在 Windows 10/11、Node 24、Windows Terminal + PowerShell 中执行：

```powershell
npm ci
npm run check
node dist/bin/bitori.js --help
```

Linux 开发机可完成 typecheck、lint、build 与大多数非平台绑定测试；`run_command`、Windows 反斜杠路径和真实终端人工验收必须按 checklist 在 Windows 环境执行。
