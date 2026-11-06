# AGENTS.md

本仓库的 agent 协作规则。工程类技能（`to-spec` / `to-tickets` / `triage` / `implement` / `wayfinder` 等）在开始工作前读取本文件与 `docs/agents/` 下的配置。

## Agent skills

### Issue tracker

Issues 与 spec 存放在 GitHub Issues（`Witty-Felix/my-workspace`），通过 `gh` CLI 读写。See `docs/agents/issue-tracker.md`.

### Triage labels

五个规范 triage 角色，标签字符串与角色同名，作为 GitHub label 应用。See `docs/agents/triage-labels.md`.

### Domain docs

single-context 布局：根目录 `GLOSSARY.md` + `docs/adr/`。See `docs/agents/domain.md`.
