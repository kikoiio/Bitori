# Claude Code TUI 界面调研（v2.1.314）

调研问题：Claude Code 2.1.314 的 TUI 如何展示工具调用、分屏、快捷键和 diff，Bitori 应复刻哪些可观察行为。下游实现见 [当前架构](../architecture.md)。

本文所有界面细节来自 2026-10-30 对本机 Claude Code 2.1.314 的真实 pty 捕获（130×44，xterm-256color），权限模式为 `default` / `auto`；键盘表同时参考了二进制内的默认键位数据。捕获帧当时写在调研工作区 `.tmp/tui-lab/`，未纳入版本库，工作区随后已清理；结论以本文为准。

## 1. 工具调用如何显示

### 基本单元

- 工具调用是一行「圆点 + 工具名 + 主要参数」：`● Update(fib.py)`、`● Bash(python3 fib.py)`、`● Read(notes.txt)`。`●` 用颜色区分运行中/成功，参数只保留最能定位对象的那一个。
- 结果紧跟在下一行，用 `⎿` 起头并缩进：`⎿ Added 3 lines`、`⎿ 0 1 1 2 3 5 8 13`、`⎿ (No output)`。
- 模型正文也是一行 `●` 开头的块，正文之间用空行分隔，视觉上与工具行同构但无参数括号。
- 执行中的动词是进行时短语，放在工具行：`● Reading notes.txt`、`● Reading 1 file…`。完成后该行被折叠替换掉。

### 折叠与摘要

默认视图只保留「有信息量」的调用。连续的低价值调用会被压成一行摘要，无圆点、弱化显示：

```
  Read 1 file

● Update(fib.py)
  ⎿  Added 2 lines, removed 1 line

  Ran 1 shell command
```

摘要按操作类型聚合（`Read N file(s)`、`Ran N shell command(s)`），插在对话流中最近的调用之前。这让一屏能看到完整任务脉络，而不是十几个 Read。

### 详细视图

`ctrl+o` 在「折叠视图」与「详细 transcript」之间切换。详细模式下：

- 参数完整展开，包括多行 heredoc：`● Bash(cat > fib.py << 'EOF' … EOF)`；
- 显示每次工具结果全文与时间戳；
- 自动放行会追加一行 `⎿ Allowed by auto mode`，把权限决策也纳入审计流；
- 底部出现专属提示条：`Showing detailed transcript · ctrl+o to toggle · ↑↓ scroll · v to open in code · ? for shortcuts`，右端标注 `verbose`。

`ctrl+e` 在 transcript 内展开被截断的输出（show all）。

### 运行态反馈

- 生成中有一行随机动词的旋转指示器：`✢ Hyperspacing… (1m 46s · ↓ 1.5k tokens)`，同时给出已耗时和已接收 token 数，动词用弱色，括号信息更弱。
- 结束后换成：`✻ Worked for 3m 11s · done 9:41 AM`。动词在 Cogitated / Hyperspacing / Crystallizing 之间随机，避免长时间等待时的机械感。
- 右上角常驻当前 effort：`● high · /effort`。

### 权限对话框

工具调用触发权限时，输入区上方弹出全宽对话框，三段式：标题 → 说明 → 虚线分隔的选项列表。

Bash 命令对话框：

```
 Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode" below
 Create notes.txt with four lines
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 printf 'alpha\nbeta\ngamma\ndelta\n' > notes.txt && cat notes.txt
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to <dir> from this project
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No

 Esc to cancel · Tab to amend
```

Edit 对话框同构，标题换成 `Edit file` + 文件名，正文是 diff 预览，问题为 `Do you want to make this edit to notes.txt?`，选项三选一（Yes / Yes 并切到 accept edits / No）。要点：

- 编号 + `❯` 光标，数字键或方向键都能选；
- 「本次 / 本目录持久 / 切模式」三档授权直接写进选项文案，用户不必先理解权限模型；
- 底部一行固定快捷键，`Tab to amend` 允许改参数后重试；
- 说明行用人话描述副作用（`Creating notes.txt with four lines`），不直接抛原始 JSON。

## 2. 分屏布局方式

### 默认：单列滚动 + 固定底部区

默认渲染器不是全屏应用，而是向终端 scrollback 追加内容，底部固定三块：

1. `─` 横线围成的输入框（上下各一条，提示符 `❯`）；
2. 状态行：`cwd  ctx 1% (9k)  Model (branch)`；
3. 模式行：`⏸ manual mode on` / `⏵⏵ auto mode on (shift+tab to cycle)`。

对话区没有固定高度上限，历史往上滚。长内容靠折叠控制信息密度，而不是靠视口分页。

### `/diff`：右侧分栏面板

`/diff` 在原对话右侧打开一条竖向分栏（130 列下约占 1/4 宽），左侧对话区被重新排版到更窄的列宽：

```
 ❯ Use the TodoWrite …          │                       ✕
   Read 1 file                  │       source: Current ▾
 ● Update(notes.txt)            │
   ⎿ Added 2 lines, removed 1   │
      2 -beta                  │
      2 +BETA                  │        No changes this session
```

- 分隔线用 `│`，右上角 `✕` 关闭；
- 面板头部是数据源选择器 `source: Current ▾`，默认「Current」= 本次会话的改动；`ctrl+x b` 或左右方向键切到 `uncommitted (vs HEAD)`，此时内容来自 git；
- 空状态有独立文案（`No changes this session`、`No uncommitted changes`），不是留白；
- 面板是「伴随式」的：对话照常可读、输入框照常可用，得用面板打开后 Esc 关闭。

### 其他分屏形态

- 权限对话框占满底部宽度，覆盖输入区，对话区仍留在上方可见。
- `ctrl+x ctrl+a` 在输入框上方打开独立 pane（Pane / AbovePrompt 键位上下文），用于放长结果或辅助视图。
- 另有 `/tui fullscreen` 全屏渲染器，作为非全屏默认模式的替代（本次未捕获）。

结论：Claude Code 的「分屏」是**侧栏式**，不是 tmux 那种任意切分。对话是唯一主视图，其他面板（diff、pane、对话框）都是附着在主视图边缘或底部的临时层。

## 3. 快捷键

### 输入与提交

| 键 | 行为 |
|---|---|
| `Enter` | 提交 |
| `\` + `Enter`（反斜杠换行） | 插入换行 |
| `Ctrl+J` | 插入换行 |
| `Esc Esc`（双击） | 清空输入；在空闲时打开 Rewind |
| `Ctrl+C` | 取消当前生成；空输入时退出 |
| `Ctrl+D` | 退出 |
| `Ctrl+S` | 暂存草稿（stash prompt） |
| `Ctrl+Z` | 挂起进程（suspend） |
| `Ctrl+Shift+_` / `Ctrl+_` | 撤销输入 |
| `Ctrl+V` | 粘贴图片 |

### 模式与命令入口

| 键 | 行为 |
|---|---|
| `/` | 斜杠命令补全（弹出两列：命令 + 说明） |
| `@` | 文件路径补全 |
| `!` | shell 模式（直接执行命令，结果进入上下文） |
| `Shift+Tab` | 循环权限模式：manual → accept edits → plan → auto（页脚实时更新） |
| `Alt+P` / `Meta+P` | 切换模型 |
| `Shift+↑/↓` | 调整 effort |
| `?` | 打开快捷键帮助面板 |

### 视图与面板

| 键 | 行为 |
|---|---|
| `Ctrl+O` | 切换详细 transcript / 折叠视图 |
| `Ctrl+E` | transcript 内展开全部输出 |
| `Ctrl+T` | 切换任务（todo）面板 |
| `Ctrl+R` | 历史搜索 |
| `Ctrl+G` | 用 `$EDITOR` 编辑当前输入 |
| `Ctrl+X Ctrl+E` | 同上（外部编辑器） |
| `Ctrl+X Ctrl+B` | 切换 diff 面板数据源（Current / uncommitted） |
| `Ctrl+X Ctrl+A` | 打开输入框上方 pane |
| `Ctrl+B` | 把任务转入后台 |
| `Esc` | 关闭当前面板 / 取消 |

### 快捷键体系

- 键位按**上下文**分组：Global、Chat、Confirmation、Transcript、DiffPanel、DiffDialog、Pane/AbovePrompt、Task、HistorySearch、Scroll、Agents。同一个键在不同上下文可绑不同动作，冲突按上下文优先级解析。
- 用户可通过 `~/.claude/keybindings.json` 覆盖默认值，格式为 `{"bindings":[{"context":"Chat","bindings":{"ctrl+alt+g":"command:…"}}]}`；`/keybindings` 提供可视化编辑器。
- 帮助面板（`?`）不是全量键表，而是分四列的高频操作速查：左边是入口（`!` `/` `@` `/btw`），中间是编辑操作（双击 Esc、`\⏎`、Ctrl+O、Ctrl+T），右边是会话级操作（撤销、suspend、粘贴图片、换模型、stash、`$EDITOR`、`/keybindings`）。全量键表交给 `/keybindings`。
- 状态行会随模式改写提示：auto 模式显示 `⏵⏵ auto mode on (shift+tab to cycle)`，manual 显示 `⏸ manual mode on`。模式不是隐藏状态，始终在输入框下方可见。

## 4. Diff 视图

### 内联 diff（工具结果内）

Edit / Update 的结果直接内联展示，不弹窗：

```
● Update(notes.txt)
  ⎿  Added 2 lines, removed 1 line
      1  alpha
      2 -beta
      2 +BETA
      3 +epsilon
      4  gamma
      5  delta
```

- 首行摘要用自然语言复数：`Added 3 lines`、`Added 2 lines, removed 1 line`；无删除时省略 removed 子句。
- 行格式：`行号` + 空格 + 标记（`+`/`-`/空格）+ 内容。上下文行是新旧共有的行，只标一个新文件行号；删除行标旧行号，新增行标新行号，因此 `2 -beta` 与 `2 +BETA` 行号相同，能直观看出是替换。
- 默认只显示变更附近若干行上下文，超出部分折叠（二进制内还有 `Proposed edit is too large to show` 的超大编辑兜底文案）。
- 行级 diff 之上还有**词级 diff**：内部把每行切成 add / remove / nochange 片段，用 `wordDiff` 计算、`matchedLine` 对齐，再按 `gutterWidth` 排版。效果是 `beta` → `BETA` 这种小改只高亮变化的词，而不是整行标红再标绿。

### 权限对话框中的 diff

Edit 权限请求把同一份 diff 作为「你要批准的内容」呈现，标题 `Edit file` + 路径，正文 diff 区上下用虚线分隔。选项文案直接说明后果（`Yes, and switch to accept edits … (shift+tab)`），把「批准一次」和「改变后续策略」分开。

### Rewind 中的变更摘要

`Esc Esc`（空闲时）打开 Rewind 列表，每条历史节点显示：用户 prompt 摘要 + 该节点的文件变更统计：

```
   Rewind

   Restore the code and/or conversation to the point before…

     Use the TodoWrite tool first to track three steps. Then use the Write tool (NOT bash) to create notes.txt containing ex…
     notes.txt +2 -1

   ❯ (current)

   Enter to continue · Esc to cancel
```

`+N -M` 是紧凑的变更指纹，让用户不打开 diff 也能判断该回退点改了什么。`(current)` 标记当前位置，语义是「回退到这一点之前」，避免歧义。

### `/diff` 面板

- 左侧对话、右侧 diff 的侧栏布局（见第 2 节）；
- 数据源可切：`Current`（本会话改动）与 `uncommitted (vs HEAD)`（git 工作区改动）；
- 面板内按键属于 DiffPanel / DiffDialog 上下文，与主对话键位隔离。

## 5. 对 Bitori 的启示

调研当日的 Bitori（`src/tui/components/tool-call-card.tsx`）每个工具是一行 `⚙ name · approval · status`，参数截断 160 字符；审批面板是 `Y/S/P/N` 四键；没有 diff 视图、transcript 模式和侧栏面板（`src/tui/render.tsx` 用 `alternateScreen: true`，全屏单视图）。当时建议优先补的四件事：

1. **折叠摘要**：低价值的 Read/Grep 聚合成 `Read N files`，只让写操作和命令占整行——这是 Claude Code 一屏信息量的主要来源。
2. **内联 diff**：`⎿ Added N lines, removed M lines` + 双行号 gutter + 词级高亮。审批面板直接复用同一渲染器，用户批准的就是他看到的。
3. **详细视图开关**：一个键在折叠/全量之间切换，比在每张卡上放展开按钮更省空间。
4. **侧栏 diff 面板**：Bitori 已用 alternateScreen，做右侧分栏比 Claude Code 的非全屏方案更自然；面板打开时对话区重排窄列，Esc 关闭。

## 6. 未验证项

以下项目在捕获中未取得有效帧（按键在应用忙碌时被当作输入文本吞掉，或该功能在 `--bare` 下不可用）：

- `/keybindings` 可视化编辑器（只捕获到 `Crystallizing…` 与加载提示）；
- `Shift+Tab` 模式切换的逐帧画面（manual / auto 页脚文本已实测，中间模式仅来自二进制字符串）；
- `/context` 彩色网格；
- `!` shell 模式的输入态；
- `Ctrl+T` 任务面板（`--bare` 下 TodoWrite 工具不可用，面板为空）；
- `Ctrl+X Ctrl+A` 上方 pane；
- Edit 权限对话框的 diff 正文（捕获中渲染为 `…`，疑似空间不足时的占位）。
