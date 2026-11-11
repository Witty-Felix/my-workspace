# AGENTS.md

本仓库的 agent 协作规则。工程类技能（`to-spec` / `to-tickets` / `triage` / `implement` / `wayfinder` 等）在开始工作前读取本文件与 `docs/agents/` 下的配置。

## Agent skills

### Issue tracker

Issues 与 spec 存放在 GitHub Issues（`Witty-Felix/my-workspace`），通过 `gh` CLI 读写。See `docs/agents/issue-tracker.md`.

### Triage labels

五个规范 triage 角色，标签字符串与角色同名，作为 GitHub label 应用。See `docs/agents/triage-labels.md`.

### Domain docs

single-context 布局：根目录 `GLOSSARY.md` + `docs/adr/`。See `docs/agents/domain.md`.

### 交互原型

`design/prototypes/` 放一次性原型（多方案对比 + 量尺），不进版本库（`.gitignore` 已忽略）。ADR 里提到「原型里有这行」时，同一目录名要能对上；原型验证完就随会话丢弃，结论只留在 ADR。

预览会把 HTML 提取到独立目录打开，**外部相对路径全部失效**。原型要自带样式：把 `app/public/style.css` 原样拷进 `<style>`（保留一行注释标明来源），别用 `<link href="../../...">`。

改**拖拽、落位、触屏交互**前，先读 `docs/adr/0006-drag-place.md`（该行为的三次修订都在里面，含触屏 pointercancel 的根因与约束）。

### 多轮需求落地

一个会话里用户分多轮提出过 UI/交互要求的，动手改代码前先把**全部**要求列成 checklist 逐条核对——只对最后一轮是最常见的漏项来源。

### 两端一起做

**工作台有两套界面：桌面七列纸（`#week`）与手机当天纸（`#phone`）。任何界面改动都必须两端都做，交付前两端都看一眼。**

这不是风格问题，是这个仓库最容易漏的一项：`@media (max-width:900px)` 里 `.nav{display:none}`、`.sheet{display:none}` —— 桌面上的按钮和容器在手机上根本不存在，而桌面截图一切正常，所以漏掉的永远不会自己暴露。2026-11-11 的周规划就是这样：顶栏「规划」按钮在手机端完全不可见。

落地规则（入口怎么给、浮层怎么换、写操作要重画哪几处）见 `CODING_STANDARDS.md` 的「两端」与「写操作」两节。

### Checks

改动前后跑 `cd app && npm run check && npm run smoke`；发布走 `cd app && npm run deploy`（不要手写 tar/ssh）。见 `docs/deploy.md`。

**看图不要自己拼 headless 命令**：用 `node app/scripts/shot.mjs <路径或URL> <输出目录> <宽> <高>`。它用 CDP Emulation 定视口（Windows 显示缩放会把 `--window-size` 放大成 492，Chromium 无头还有最小窗口宽度），量到视口不符就中止而不是出一张误导图；文件名带时间戳，避开看图工具的缓存。

**四个浏览器自检，改了对应行为就必须跑，都本地、都不进 CI**：`smoke:drag`（拖拽落位）、`smoke:done`（完成态）、`smoke:plan`（周规划桌面）、`smoke:plan-mobile`（周规划手机端，390 宽）。新写自检用 `scripts/lib/harness.mjs`（带 `emulate` 定窄视口、`emptyData` 起空库），别手抄「起服务 → 等端口 → 连 CDP」那套样板。

要起服务验证接口时，启停写进**同一条命令**：后台进程不跨命令存活，分开跑会拿到 `upstream connect failed`。参照 `scripts/smoke.sh` 的 `(cd app && exec env PORT=… node server.js) & … kill $!` 写法。

`npm run smoke` 的第 2 项是**逐字 DOM 比对**（对 HEAD 基线）：**静止态 DOM 就是基线**。有意改 DOM 或接口响应时跑 `SMOKE_ACCEPT=1 npm run smoke`，它会打印相对旧基线的增删行数，把 `app/scripts/*-accepted.diff` 和代码一起提交。拖拽态这类只在交互中出现的东西靠「运行时才生成节点」绕开。

钩子在 `.githooks/pre-commit`（check + ADR 漂移 + 文档事实）。新克隆启用一次：`git config core.hooksPath .githooks`。

### Coding standards

改 `app/` 前读 `CODING_STANDARDS.md`（判断题：乐观写、静止态 DOM、稀疏字段、词表、零依赖）。
