# Bitori UI/UX 研究与改进计划

## 当前 Bitori CLI UX 状态

### 已实现功能
- ✅ 基本聊天界面（消息列表、输入框）
- ✅ 工具审批面板（Y/S/P/N）
- ✅ 调试面板（Ctrl+T）
- ✅ 会话管理（Ctrl+N/O）
- ✅ 快捷键（Ctrl+C 退出，Tab 切换焦点）
- ✅ Ink/React TUI 渲染

### 体验问题
- ❌ **无分屏布局**：单列设计，无法同时查看代码和对话
- ❌ **工具调用展示简单**：只有简单的文本列表，没有实时状态
- ❌ **无实时 Diff**：文件修改不显示对比
- ❌ **无代码预览**：无法在 TUI 中查看文件内容
- ❌ **输入框固定底部**：没有全屏渲染模式
- ❌ **视觉设计基础**：缺乏现代 TUI 的视觉层次
- ❌ **快捷键不丰富**：缺少常用快捷键（如历史搜索、粘贴图片等）

## Claude Code UI/UX 设计特点

### 核心设计理念
**Observable Autonomy（可观察的自主性）**
- Agent 自由行动，但用户实时看到每一步
- 流式输出工具调用和结果，而非完成后才显示
- 用户可以在 3 秒内 Ctrl+C 中断，而非等待 20 秒后撤销
- 最小化中断：只在真正需要权限确认时才打扰用户

### 关键特性

#### 1. 全屏渲染模式
- 使用 alternate screen buffer（类似 vim/htop）
- 输入框固定底部，不会随输出移动
- 只渲染可见消息，内存占用恒定
- 解决终端滚动到顶部、屏幕闪烁的问题

#### 2. 工具调用可视化
- **实时流式展示**：工具调用参数和进度实时显示
- **多种权限对话框**：
  - BashPermission - Shell 命令执行
  - FileEditToolDiff - 文件编辑（带 Diff 预览）
  - FileWritePermission - 文件写入
  - McpToolPermission - MCP 工具调用
  - AgentPermission - Agent 启动
  - WorktreePermission - Worktree 创建
  - BypassPermissionsModeDialog - 危险模式确认
  - AutoModeOptInDialog - 自动模式确认
- **200ms 防误触延迟**：权限对话框有 200ms 延迟防止误操作

#### 3. 快捷键系统
- `Ctrl+C` - 中断/清除输入/退出
- `Ctrl+X Ctrl+K` - 停止所有后台 subagent
- `Ctrl+D` - 退出（需确认）
- `Ctrl+G` / `Ctrl+X Ctrl+E` - 在外部编辑器编辑
- `Ctrl+L` - 重绘屏幕
- `Ctrl+O` - 切换 transcript viewer（详细工具使用）
- `Ctrl+R` - 反向搜索命令历史
- `Ctrl+V` - 粘贴图片

#### 4. Transcript Viewer（Ctrl+O）
- 显示详细工具使用和执行
- 时间戳和模型信息
- 展开默认折叠的行（MCP 调用等）
- 显示其他会话的消息预览

#### 5. 其他特性
- 历史导航（上下箭头浏览）
- 命令建议（输入 `/` 触发）
- 图片粘贴支持
- Emoji 支持
- IDE 选择集成
- 模式切换（权限模式循环）
- 多行输入（Shift+Enter 换行）
- 早期输入捕获（启动时捕获按键）

## Devin UI/UX 设计特点

### 核心设计理念
**Agent Status & Monitoring（分层状态系统）**
- 四层状态：ambient（环境状态）、progress（进度）、attention（注意）、summary（摘要）
- 用户在不被迫观看的情况下保持知情
- 支持多并发任务

### 关键特性

#### 1. 工具调用展示
- **紧凑单行摘要**：工具调用在 transcript 中显示为单行
- `Ctrl+O` 展开完整工具卡片
- 命令退出非零状态显示红色叉
- `agent.verbosity` 设置控制详细程度

#### 2. 权限提示
- Allow（允许）、Bypass mode（绕过模式）、Deny（拒绝）
- Allow 可选择持续时间：Once、Session、Project、Always
- 按 `e` 编辑命令

#### 3. Slash 命令（即时执行）
- `/status`、`/context`、`/fast`、`/session-stats`、`/help` 等
- 在 agent 工作时立即执行，无需排队
- 渲染到 scrollback 而非打字机效果
- 每个命令配对独立回复

#### 4. 实时状态监控
- **Live Terminal View**：实时显示 agent 正在做什么
- 运行测试、读取文件、编写代码
- 可放大查看任何步骤或缩小查看摘要
- Shell 命令历史：
  - 显示所有命令及输出预览
  - 复制功能和命令
  - 时间导航

#### 5. Session Tools
- **Shell**：监控命令、查看输出、运行自己的命令
- **IDE**：接管 Devin 的工作
- **Browser**：在真实浏览器中验证
- **Progress Tab**：统一视图

#### 6. 模型选择
- `/model`、`/models` 命令
- 快捷键切换模型
- 在 agent 工作时也能切换

#### 7. 上下文显示
- `/context` 显示各部分的 token 和百分比
- 一条 bar 对应一个部分（system prompt、tools、messages、free）

## 第三方工具生态

### Claude Code 可视化工具
1. **claude-watch** - Web 仪表板
   - 实时流式传输 thinking、tool calls、subagents
   - 多会话树视图
   - Token 统计页面
   - 子代理跟踪

2. **claude-code-devtools** - Chrome DevTools 风格
   - 实时时间线
   - 上下文检查器
   - 文件热力图
   - 回放 scrubber
   - 三面板布局

3. **claude-esp** - TUI 分离显示
   - 在单独终端中显示输出
   - 多会话支持
   - 层级树视图
   - 实时流式传输
   - 过滤功能

4. **claude-hindsight** - Web 仪表板
   - 全功能仪表板
   - 实时 SSE 流式传输
   - 3D 执行图
   - 离线工作

5. **claude-code-controller** - 浏览器控制
   - 从浏览器启动会话
   - 实时流式传输
   - 交互式权限控制
   - 多会话管理

## Bitori 改进计划

### 阶段 1：核心体验改进（高优先级）

#### 1.1 工具调用实时可视化
**目标**：像 Devin 一样显示工具调用过程和结果

**实现**：
- 将当前简单的 `ToolCallList` 改为卡片式展示
- 显示工具调用状态：pending → running → completed/failed
- 实时流式显示工具输出（类似 Claude Code）
- 工具调用折叠/展开（默认摘要，按 `Ctrl+O` 展开）

**技术方案**：
```typescript
// 新组件 ToolCallCard
interface ToolCallCardProps {
  toolName: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  arguments: unknown;
  output?: string;
  duration?: number;
  expanded: boolean;
  onToggle: () => void;
}
```

#### 1.2 分屏布局
**目标**：左侧代码/文件，右侧对话

**实现**：
- 使用 Ink 的 Box flexDirection="row"
- 左侧面板：文件树 + 代码预览
- 右侧面板：对话 + 工具调用
- 可调整面板宽度（←/→）

**技术方案**：
```typescript
// 布局结构
<Box flexDirection="row" height={height}>
  <Box width={leftPanelWidth} flexDirection="column">
    <FileTree />
    <CodePreview />
  </Box>
  <Box flexGrow={1} flexDirection="column">
    <MessageList />
    <ToolCallPanel />
    <PromptInput />
  </Box>
</Box>
```

#### 1.3 文件修改 Diff 展示
**目标**：显示文件修改的 Diff

**实现**：
- 在工具调用时检测文件修改
- 使用 diff 库生成 unified diff
- 在工具卡片中显示 Diff
- 支持接受/拒绝单个修改

**技术方案**：
```typescript
// 新组件 DiffView
import {diffLines} from 'diff';

function DiffView({oldContent, newContent}: Props) {
  const changes = diffLines(oldContent, newContent);
  // 渲染：+ 绿色，- 红色
}
```

#### 1.4 全屏渲染模式
**目标**：解决输入框移动、屏幕闪烁问题

**实现**：
- 使用 alternate screen buffer
- 只渲染可见消息（虚拟滚动）
- 输入框固定底部

**技术方案**：
- 需要研究 Ink 是否支持 alternate screen
- 可能需要直接使用 terminal 原生控制序列

### 阶段 2：交互优化（中优先级）

#### 2.1 快捷键系统重构
**目标**：参考 Claude Code 的快捷键

**新增快捷键**：
- `Ctrl+O` - 切换工具调用详细视图
- `Ctrl+R` - 反向搜索命令历史
- `Ctrl+L` - 重绘屏幕
- `Ctrl+G` - 在外部编辑器编辑输入
- `Ctrl+P` - 上一个命令
- `Ctrl+N` - 下一个命令
- `Ctrl+K` - 清除当前行
- `Shift+Enter` - 多行输入
- `Esc` - 清除输入/退出工具详情

#### 2.2 流式输出优化
**目标**：更流畅的打字效果

**实现**：
- 减少 flicker
- 优化渲染性能
- 支持打字机效果可配置

#### 2.3 状态反馈增强
**目标**：更好的加载动画和进度指示

**实现**：
- 工具调用进度条
- Agent 思考动画
- 错误提示更友好
- Token 使用实时显示

#### 2.4 命令历史和搜索
**目标**：快速访问历史命令

**实现**：
- 命令历史存储
- 反向搜索（Ctrl+R）
- 模糊匹配

### 阶段 3：视觉设计改进（中优先级）

#### 3.1 颜色和主题
**目标**：现代 TUI 视觉设计

**实现**：
- 统一的颜色方案
- 语法高亮
- 状态颜色（成功绿色、错误红色、警告黄色）
- 支持亮色/暗色主题

#### 3.2 布局优化
**目标**：更好的空间利用

**实现**：
- 响应式布局
- 自适应终端大小
- 更好的间距和对齐

#### 3.3 图标和符号
**目标**：增强视觉识别

**实现**：
- 使用 Unicode 符号
- Spinner 动画
- 状态图标

### 阶段 4：高级特性（低优先级）

#### 4.1 图片粘贴支持
**目标**：粘贴图片到对话

**实现**：
- 检测剪贴板图片数据
- 转换为 inline image
- 显示图片预览

#### 4.2 多会话管理
**目标**：同时管理多个会话

**实现**：
- 会话列表侧边栏
- 快速切换会话
- 会话搜索

#### 4.3 文件树导航
**目标**：在 TUI 中浏览文件

**实现**：
- 文件树组件
- 快速打开文件
- 文件搜索

#### 4.4 Slash 命令
**目标**：即时执行命令

**实现**：
- `/status`、`/context`、`/help` 等
- 即时执行（不排队）
- 命令建议

## 技术债务和限制

### 当前 Ink 的限制
- 不支持 alternate screen buffer（需要原生终端控制序列）
- 虚拟滚动需要自己实现
- 性能优化空间大

### 可能的技术升级
- 评估其他 TUI 库（如 blessed、blessed-contrib）
- 考虑 Rust TUI 库（ratatui）
- 或继续优化 Ink

## 实施优先级

### P0（必须）
1. 工具调用实时可视化
2. 分屏布局（代码 + 对话）
3. Diff 展示

### P1（重要）
1. 全屏渲染模式
2. 快捷键系统重构
3. 流式输出优化

### P2（改进）
1. 状态反馈增强
2. 视觉设计改进
3. 命令历史和搜索

### P3（可选）
1. 图片粘贴支持
2. 多会话管理
3. 文件树导航
4. Slash 命令

## 实际体验进行中

### Claude Code 体验（进行中）
已在 Orca worktree 中启动 Claude agent 实际分析 Claude Code TUI：
- Worktree: `/home/neo/orca/workspaces/Bitori/uiux-research`
- Agent: Claude (Fable 5.1)
- 任务：分析 Claude Code TUI 的工具调用显示、分屏布局、快捷键和 Diff 视图
- 状态：正在分析中（已读取 docs/PLAN.md 和 git log，计划深入研究）
- 进度：正在读取分支研究计划和提交历史

### Devin 体验（进行中）
已在 Orca worktree 中启动 Devin agent：
- Worktree: `/home/neo/orca/workspaces/Bitori/uiux-research-devin`
- Agent: Devin
- 任务：分析 Devin TUI 的工具调用显示、命令历史、状态监控和快捷键
- 状态：思考中

### 内存状况（检查时间：当前）
- MemAvailable: 6.3GB（充足）
- Swap: 4GB 已满（但无持续换页）
- si/so: 0（无持续换页压力）
- 两个 agent 可以继续并行运行

### 下一步行动

1. 等待 Claude 和 Devin agent 完成分析
2. 记录实际体验发现到 docs/uiux-research.md
3. 基于实际体验调整改进计划
4. 继续实现剩余阶段 2 和阶段 3 的改进
