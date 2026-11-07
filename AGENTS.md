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

`npm run smoke` 的第 2 项是**逐字 DOM 比对**（对 HEAD 基线，归一化后不得有差异），也就是说：**静止态 DOM 就是基线**。要加元素、加属性、改静态结构，先决定是重建基线还是绕开结构（`scripts/smoke.sh` 第 2 节说明了比对方式）。拖拽这一类只在交互中出现的东西，靠"运行时才生成节点"来避开这条线。

`npm run smoke:drag` 是拖拽的端到端自检（真浏览器真鼠标，本地跑，不在 CI）——改拖拽/落位/翻页后必须跑。

钩子在 `.githooks/pre-commit`（跑 check + ADR 漂移 + 文档事实三项）。新克隆要启用一次：`git config core.hooksPath .githooks`。smoke 与拖拽自检留给 CI 和手动。
