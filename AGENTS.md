# AGENTS.md

本仓库的 agent 协作规则。工程类技能（`to-spec` / `to-tickets` / `triage` / `implement` / `wayfinder` 等）在开始工作前读取本文件与 `docs/agents/` 下的配置。

## Agent skills

### Issue tracker

Issues 与 spec 存放在 GitHub Issues（`Witty-Felix/my-workspace`），通过 `gh` CLI 读写。See `docs/agents/issue-tracker.md`.

### Triage labels

五个规范 triage 角色，标签字符串与角色同名，作为 GitHub label 应用。See `docs/agents/triage-labels.md`.

### Domain docs

single-context 布局：根目录 `GLOSSARY.md` + `docs/adr/`。See `docs/agents/domain.md`.

### Checks

改动前后跑 `cd app && npm run check && npm run smoke`；发布走 `cd app && npm run deploy`（不要手写 tar/ssh）。见 `docs/deploy.md`。

`npm run smoke` 的第 2 项是**逐字 DOM 比对**（对 HEAD 基线，归一化后不得有差异）：**静止态 DOM 就是基线**。有意改 DOM 或接口响应时，跑一次 `SMOKE_ACCEPT=1 npm run smoke`，把 `app/scripts/*-accepted.diff` 和代码一起提交——基线变更就是那次提交里可评审的 diff，CI 的 `HEAD~1` 比对会认它。拖拽这类只在交互中出现的东西，仍然靠「运行时才生成节点」绕开。

`npm run smoke:drag` 是拖拽的端到端自检，`npm run smoke:done` 是完成态的（勾选/刷新/取消/键盘/已完成卡仍可拖）。两个都跑真浏览器、本地跑、不在 CI——改对应行为后必须跑。

钩子在 `.githooks/pre-commit`（跑 check + ADR 漂移 + 文档事实三项）。新克隆要启用一次：`git config core.hooksPath .githooks`。smoke 在 CI 与提交前手动跑；两个交互自检只手动。

### Coding standards

改 `app/` 前读 `CODING_STANDARDS.md`（判断题：乐观写、静止态 DOM、稀疏字段、词表、零依赖）。
