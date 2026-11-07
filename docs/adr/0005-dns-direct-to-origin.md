---
status: active
date: 2026-11-07
---

# 入口链路：从 Cloudflare 代理改为 DNSPod 直连源站 + 真证书

自 2026-11-07 17:27 起，`my-workspace.324614917.xyz` 的 DNS 托管从 Cloudflare（`stanley` / `amalia.ns.cloudflare.com`）切回腾讯云 DNSPod（`deer` / `false.dnspod.net`），解析**直指源站 `139.224.192.94`**，不再经过 Cloudflare 反代。源站 443 由自签证书换为 TrustAsia DV 证书（`/opt/gateway/certs/`）。

## 为什么要换

原链路是「国内手机 → Cloudflare 海外边缘 → 跨境回源阿里云上海」。Cloudflare 免费版在中国大陆没有边缘节点，实测请求被调度到阿姆斯特丹（`cf-ray: ...-AMS`），同一条链路下：

| 路径 | 首字节 |
|---|---|
| 直连源站 | 47–50 ms |
| 走 Cloudflare | 1280–1922 ms |

**差 38 倍。** 手机端表现为首屏 30 秒白屏、换周/添加操作点了没反应。

## Considered Options

- **保留 CF 橙云 + 调优**（Argo $5/月、优选 IP）：跨境本质没变，改善有限且需持续维护。
- **进 Cloudflare 面板把橙云改灰云**：效果等同直连，但 DNS 仍托管在 CF；且子域 `api` 的 Pages 绑定会失效。
- **换 NS 回 DNSPod 直连**：即本 ADR 的选择。该域名 2026-10-05 之前本就托管在 DNSPod，是回头路，零新流程；顺带为日后的备案 + 国内 CDN（EdgeOne）铺路。
- **备案 + 腾讯云 EdgeOne**：最合规的长期解，但要 1–2 周备案周期，本次不阻塞。

## Consequences

- **源站 IP 直接暴露**，失去 Cloudflare 的 DDoS 防护与边缘缓存。个人工具站可接受，风险写进文档而非藏起来。
- **HTTPS 必须靠源站自己**：自签证书只能骗过 CF 的 `Full` 模式，浏览器直连会报警，因此同步换成 TrustAsia DV；**90 天到期**（2027-02-05），续期需人工或后续上 acme.sh + DNSPod API 自动签。
- **Cloudflare Pages 绑定失效**：`api.324614917.xyz`（CNAME → `jiese-checkin.pages.dev`）依赖 zone 托管在 CF，切走后不再服务；`izzy-happybirthday`（生日页）一并下线。二者经确认均不再使用。
- **合规缺口仍在**：未备案域名直连国内服务器严格说不合规（阿里云轻量目前不拦截）。长期解仍是备案 + EdgeOne。
- **回滚**：DNS 改回 `stanley.ns.cloudflare.com` / `amalia.ns.cloudflare.com` 即恢复原链路；CF 侧 zone 与记录未删除，证书备份在 `/opt/gateway/certs.bak-20261107/`。

## 与既有 ADR 的关系

- **ADR-0003（80 端口由网关统一分发）**：形态不变，网关仍是唯一入口，本次只换了证书与 DNS 指向。
- **ADR-0004（免登录）**：不受影响，`AUTH=off` 继续有效。直连后链路仍为 HTTPS，比原先的明文 HTTP 更进一步。
- **ADR-0002（Docker + Node + JSON 文件）**：容器形态、端口、数据目录均不变。

## 排障要点

- 判断是否真的直连：`nslookup my-workspace.324614917.xyz` 应返回 `139.224.192.94`，而非 `104.21.x` / `172.67.x`（后者是 CF 代理 IP）。
- 判断证书是否生效：`openssl s_client -connect 139.224.192.94:443 -servername my-workspace.324614917.xyz | openssl x509 -noout -issuer` 应显示 TrustAsia，而非自签。
- DNSPod 侧状态「未使用云解析 DNS 地址」= 注册局 NS 与 DNSPod 分配的不一致；域名详情页悬停该状态可看到要求填写的 NS 对。
