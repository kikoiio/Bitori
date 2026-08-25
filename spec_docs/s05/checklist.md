# MyCode 五层权限系统 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。
> 自动化验证以 `npx vitest run <路径>` 或 `npm run check` 为准；标注「人工」的项在
> Windows Terminal 的 PowerShell 中启动真实会话执行。

## 实现完整性

- [ ] 黑名单六类全拦截：递归删除、格式化/分区、关机重启、注册表高危、禁用安全组件、
  下载执行的代表命令在「放行档 + 命中 allow 规则」下仍被拒绝，拒绝原因标注黑名单类别
  （验证：`npx vitest run tests/unit/permissions/blacklist.test.ts tests/unit/permissions/engine.test.ts`；AC2）
- [ ] 安全命令不被黑名单误伤：git status、npm test、工作区内 `Remove-Item -Recurse -Force ./build`
  均不命中（验证：同上 blacklist 测试的安全用例；AC2 边界）
- [ ] 沙箱防逃逸：指向工作区外的符号链接读、写均被拒绝（含放行档）；
  工作区内不存在的深层路径不因预检报错（验证：`npx vitest run tests/unit/tools/workspace-paths.test.ts`；AC3）
- [ ] 规则解析：精确规则匹配完整命令文本；glob 匹配命令前缀与相对路径；
  含未知工具名/非法规则/YAML 语法错误的文件启动报错并指明文件
  （验证：`npx vitest run tests/unit/permissions/rule.test.ts tests/unit/permissions/rule-store.test.ts`；AC4）
- [ ] 三层合并与缺省：三层文件合并为一个集合且 source 标注正确；
  全部缺失时启动正常、行为等同默认档+空规则集
  （验证：`npx vitest run tests/unit/permissions/rule-store.test.ts`；AC5）
- [ ] 优先级与层级无关：同一调用在三层分别命中 allow/ask/deny 时结果为 deny，
  只命中 allow+ask 时为 ask，调换层级结果不变
  （验证：`npx vitest run tests/unit/permissions/engine.test.ts`；AC6）
- [ ] 只读可控：`deny read_file(**/.env)` 配置后读取工作区内 .env 被拒，
  其他文件不受影响（验证：engine 测试对应用例；AC7）
- [ ] 三档语义矩阵：严格档只读也询问且 allow 规则失效、deny 仍拒；
  默认档只读未命中放行、写/命令未命中询问；放行档写/命令直接执行、deny 仍拒
  （验证：engine 测试三档矩阵；AC8）
- [ ] 判定顺序短路：黑名单命中的命令在放行档+allow 规则下仍拒；
  沙箱逃逸路径在 allow 规则下仍拒（验证：engine 测试顺序用例；AC1）
- [ ] 会话规则同等合并：本会话放行的命令与 YAML deny 规则冲突时 deny 胜出
  （验证：engine 测试；AC11）

## 集成

- [ ] Plan 过滤在管线之前：Plan 模式下写/命令工具仍被模式过滤拦截，
  不进入权限判定（验证：`npx vitest run tests/integration/plan-mode.test.ts` 保持通过；N2）
- [ ] 放行路径不再询问：命中 allow 规则的写/命令调用不出现审批事件、
  保留串行执行屏障；连续放行的只读调用仍并发执行
  （验证：`npx vitest run tests/unit/tools/batch-coordinator.test.ts` 观察事件序列；F1/N2）
- [ ] 四选审批链路：界面四选项可见、按键 y/s/p/n 分别映射
  本次/本会话/永久/拒绝（验证：`npx vitest run tests/tui`；AC10 界面部分）
- [ ] 三种放行行为差异：选本次→下次同命令仍询问；选本会话→同会话不再询问、
  新引擎（重启）后失效；选永久→本地级 YAML 出现精确规则且当前会话立即生效
  （验证：`npx vitest run tests/integration/permissions.test.ts`；AC10）
- [ ] 审批存储兼容：四选映射回 approved/denied 入库，tool_calls 表结构无变化
  （验证：`npx vitest run tests/integration/tool-persistence.test.ts` 保持通过；N2）
- [ ] 拒绝不终止 Agent Loop：模拟模型流中先黑名单拒绝、再用户拒绝，
  回合均推进到自然完成；模型收到的工具结果含拒绝来源（layer）与中文原因
  （验证：`npx vitest run tests/integration/permissions.test.ts` 对应用例；AC12）
- [ ] /mode 全链路：`/mode allow` 后写文件不再询问；`/mode` 无参回显当前档位；
  切换写入本地级 YAML；新进程启动后恢复上次档位（含放行档）；
  状态栏全程显示档位且放行档醒目
  （验证：`npx vitest run tests/integration/permissions.test.ts` + 人工观察状态栏；AC9）
- [ ] 启动显错：项目级文件写入 `mode` 键后启动终止并指明该文件
  （验证：`npx vitest run tests/unit/permissions/rule-store.test.ts` + 人工启动观察；N4）
- [ ] 永久写入不破坏文件：本地级文件已有 mode 与其他规则时追加永久规则，
  重读后旧内容完整、新规则在列（验证：rule-store 测试；F11）

## 编译与测试

- [ ] 项目编译无错误（验证：`npm run typecheck`）
- [ ] 所有单元、集成、TUI 测试通过（验证：`npm test`）
- [ ] lint 通过（验证：`npm run lint`）
- [ ] 构建通过（验证：`npm run build`）
- [ ] 总闸：`npm run check` 全部通过（验证：运行命令观察退出码；AC13）

## 端到端场景

- [ ] 场景一·出厂回归（N2）：在无任何规则文件的工作区启动真实会话，
  只读工具自动放行、写/命令工具逐条询问，行为与 s04 一致（人工：
  新临时目录启动，发起一次读文件与一次写文件任务，观察审批出现与否）
- [ ] 场景二·AC14 全程走查：配置 `allow: ["run_command(git *)"]`、默认档启动真实会话：
  ①git status 不询问直接执行；②npm test 询问一次，选本会话后再次执行不再询问；
  ③`/mode allow` 后写文件不再询问且状态栏档位醒目；④执行黑名单命令仍被拒绝、
  Agent 继续回复；⑤重启后本会话放行的 npm test 恢复询问
  （人工：按 tests/acceptance/scenarios.md 的 s05 节逐步执行并记录）
- [ ] 场景三·严格档与只读保护（AC7/AC8 人工复核）：配置 `deny: ["read_file(**/.env)"]`，
  默认档让模型读取 .env → 被拒且模型调整策略；`/mode strict` 后普通读文件也逐条询问，
  选本次放行后下一次仍询问（人工）
