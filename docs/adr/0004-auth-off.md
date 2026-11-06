---
status: active
date: 2026-11-06
---

# 鉴权形态：应用内 Basic Auth 改为免登录（`AUTH=off`）

自 2026-11-06 起，工作台默认**免登录**：服务器 `/opt/workbench/.env` 只留一行 `AUTH=off`，不再配 `AUTH_USER` / `AUTH_PASS`。

这么定是因为实测下来 Basic Auth 在这条链路上几乎不设防——`docs/deploy.md:149` 早就写明「纯 HTTP，Basic Auth 凭据在链路上是 base64，只能防君子」；既然防不住君子，那这层形式上的登录就只剩「多一次输入」的成本，换不来真正的边界。加上这本来就是单人自用的小工具，域名与 ICP 备案尚未完成，也没有更可靠的访问边界可用（不上 Cloudflare Access、不做 IP 白名单）。于是选择把它撤掉，而不是继续维护一个给人虚假安全感的开关。

## Considered Options

- **保留 Basic Auth**：挡住随手扫到端口的人。但明文 HTTP 下凭据可被嗅探，且用户每天要点一次登录换来的安全感是假的。
- **上 Cloudflare Access / IP 白名单**：边界更硬，但要为一个小工具引入额外账号体系与配置面；备案与域名稳定后再评估。
- **维持现状不动**：即本 ADR 的选择——撤掉登录，把风险写进文档而不是藏进代码。

## Consequences

- **任何拿到 URL 的人都能读写安排**（`docs/deploy.md:81` 已如实记录）。这是本决定的已知代价，不做粉饰。
- 缓解手段三条：① 数据只有一份 `data.json`，每次保存前留 `.bak`，被改坏可回滚；② 需要收紧时，改 `.env` 为 `AUTH=basic` 并填 `AUTH_USER` / `AUTH_PASS` 后 `docker compose up -d` 即可恢复；③ 后续如接入 Cloudflare Access，可在网关层再补一层。
- 代码侧的兜底逻辑**保留不动**：`AUTH` 不为 `off` 且 `AUTH_USER` / `AUTH_PASS` 任一为空时，容器直接退出（fail-closed），防止误删凭据就把站点裸奔出去。免登录必须显式写 `AUTH=off`，不会因为漏配而静默敞开。

## 与既有 ADR 的关系

- **ADR-0002（Docker 单容器 + Node 20 + Express + JSON 文件）**：本 ADR **仅取代其中的鉴权部分**（HTTP 明文配应用内 Basic Auth）。容器形态、端口映射、数据目录、原子替换写等决策**继续有效**。
- **ADR-0003（80 端口改由网关统一分发）**：不受影响，仍是当前入口形态。

> 补记：本决定此前只落在 `docs/deploy.md` 与服务器的 `.env` 里，没同步进 ADR，导致 ADR-0002 长期与实际部署脱节。本 ADR 补上这个缺口。
