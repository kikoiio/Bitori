# Bitori 产品可靠性计划

## 维护规则

- 本文件只保留尚未完成或尚未通过真实验收的产品工作，不记录已完成实现的历史。
- 每项完成后更新[架构](architecture.md)、[开发与测试](reference/development.md)和对应测试，并从本文件删除。
- 完成全部里程碑后，删除本文件及[文档索引](README.md)中的计划链接。
- **evaluation / RSI 已暂停**：`evaluation/` 下的代码与 workflow 保留为参考，不作为当前承诺。

## 已完成并通过验证的部分（保留验收口径）

- **M1 真实 Qoder 闭环**：真实凭据下编码任务端到端 PASS（`evaluation/results/e2e-providers/2026-11-01-qoder.json`，read → pwd → write → 校验 → 回答，credits 0.30 可见）；busy/过期 idle/空回复路径由真实录制 fixture 回放（`tests/fixtures/streams/qoder/`，provider 回放/生命周期共 19 条测试）；credits 贯穿类型→存储→trace→TUI→桌面；失败场景有分类错误与下一步指引。运行方式见[开发与测试](reference/development.md)。
- **M2 核心编码循环**：桌面 edit/write diff 卡片与撤销按钮、四选项审批（含 Y/S/P/N 快捷键）、快照撤销引擎（外部修改拒绝盲目覆盖）、`/undo`；开发入口与打包形态冒烟均通过。真实 Qoder 三场景（修复失效测试 0.29 credits、补测试 0.26、小重构 0.27，产物校验 OK）见 `evaluation/results/e2e-providers/2026-11-01-qoder-{fix-test,add-test,refactor}.json`。
- **M3 诊断与 onboarding**：`bitori doctor`（真实运行 220ms/11 模型，脱敏）、`/models` 连接测试区分 DNS/401/404/协议不匹配/模型不存在、TUI 两级模型选择与桌面模型列表、空配置提示含可操作入口。
- **M4 安全审计**：威胁模型与残留风险见 [安全模型与审计](reference/security.md)；注入→审批、审批 callId 绑定、一次性批准不复用、放行档持久提示均有集成测试。
- **M4 体验补齐**：会话搜索/重命名/两步删除（TUI `r`/`d`、桌面侧栏）、附件图标去误导、credits 显示、打包冒烟覆盖新交互。

## 尚未通过真实验收的工作

- [ ] **第二协议真实 E2E**：`BITORI_E2E_PROVIDERS=1 BITORI_E2E_PROTOCOL=openai-chat npm run test:e2e:providers`（需 `OPENROUTER_API_KEY` 或 `E2E_*` 凭据；脚本与预算护栏已就绪）。通过后归档脱敏证据，确认 Qoder + 第二协议双闭环，删除本项。
- [ ] 全部完成后删除本计划与索引链接。

## 完成定义

每项都必须有：真实运行证据（脱敏）、对应自动化测试、`npm run typecheck`、`npm run lint`、`npm test`、`npm run build`，并同步更新受影响的文档。没有真实证据的离线通过不视为完成。
