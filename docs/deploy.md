# 周工作台 · 部署与运维

## 现状

| 项 | 值 |
|---|---|
| 服务器 | `139.224.192.94`（阿里云 · Alibaba Cloud Linux 3 · 2C1.8G） |
| 部署目录 | `/opt/workbench` |
| 容器 | `workbench`（`workbench:latest`，`node:20-alpine`） |
| 端口 | 宿主 `8090` → 容器 `8090` |
| 数据 | `/opt/workbench/data/data.json`（挂载进容器 `/app/data`） |
| 备份 | 同目录 `data.json.bak`，每次写入前的上一版 |
| 访问 | **`https://my-workspace.324614917.xyz/`**（DNSPod 解析直指源站 `139.224.192.94:443` → 网关 → 工作台，**不再经 Cloudflare**） |
| 证书 | **Let's Encrypt 泛域名**（`*.324614917.xyz` + `324614917.xyz`），acme.sh 自动签发与续期，无需人工 |
| 备用入口 | `http://139.224.192.94/workbench/`、`http://139.224.192.94:8090/` |
| 网关 | `gateway` 容器（`nginx:alpine`），配置在 `/opt/gateway`，同仓库 `deploy/gateway/` |
| 登录 | **已关闭**（`.env` 里 `AUTH=off`）。恢复登录：把 `.env` 改成 `AUTH=basic` + 填 `AUTH_USER`/`AUTH_PASS`，再 `docker compose up -d` |

## 首次部署（已完成，留档）

首次部署的命令**不再保留原文**——它是从仓库根打包的，照抄会把 `app/`、`docs/`、`deploy/` 一并传到 `/opt/workbench` 下，正是 2026-11-06 线上那堆残留目录的来源。

现在的做法一律走脚本（打包目录、排除项、密钥、回退档都写死在脚本里）：

```bash
cd app && npm run deploy -- --dry-run    # 先看它要干什么
cd app && npm run deploy                 # 真部署
```

需要重建一台新机器时，先手工做两件事脚本不会替你决定的事：建目录 `/opt/workbench`、写 `.env`（`AUTH=off` 或 `AUTH=basic` + 账号密码），再跑 `npm run deploy`。

## 80 端口网关

`:80` 不是 buddy 的 nginx 了，是 `gateway` 容器（ADR-0003）。它按路径分发：

| 路径 | 去向 |
|---|---|
| `/workbench/` | `workbench:8090`（剥掉前缀） |
| `/workbench` | 301 到 `/workbench/`（少了这一跳，页面里的相对路径会解析到根） |
| 其余全部 | `web:80`（buddy） |

它同时接入 `vbcd_internal` 与 `workbench_default` 两个网络，所以能按服务名找到两边。改配置后：

```bash
scp deploy/gateway/conf.d/default.conf root@139.224.192.94:/opt/gateway/conf.d/
ssh root@139.224.192.94 "docker exec gateway nginx -t && docker exec gateway nginx -s reload"
```

**挂载方式踩过的坑**：`conf.d/` 必须挂**目录**，不能挂单个文件。挂单文件时，宿主机上替换文件会换 inode，容器里仍指向旧 inode —— `nginx -t` 通过、`reload` 成功，但加载的是旧配置，表现为“改了没反应”。

buddy 那侧的端口映射已改为 `127.0.0.1:8080:80`（在 `/home/bird/vbcd/docker-compose.yml`，改前备份为 `docker-compose.yml.bak-*`）。**它不是本仓库的文件**，日后 buddy 若拉上游新版本，需要重新合并这一行。

## 子域名接入（DNSPod 直连，2026-11-07 起）

**已接通，且不再经 Cloudflare。** 真实域名是 `324614917.xyz`（9 位数字）。早期排查用的 `3246146917.xyz`（10 位）从未在注册局存在，纯属多打一位，配置里仅保留作占位。

| 项 | 状态 |
|---|---|
| 域名 | `324614917.xyz`，腾讯云注册（注册商帝思普） |
| NS | `deer.dnspod.net` / `false.dnspod.net`（腾讯云 DNSPod 免费版） |
| 解析 | `my-workspace` A → `139.224.192.94`，**直连，无代理层** |
| 证书 | Let's Encrypt 泛域名（`*.324614917.xyz` + 裸域），acme.sh 自动续期 |
| 入口 | 手机/浏览器 → 阿里云上海源站 443 → `gateway` 按 `server_name` 命中工作台 |

**为什么从 Cloudflare 迁走**：CF 免费版在大陆无边缘节点，国内请求被调度到海外（实测 `cf-ray: ...-AMS`），同一条链路实测首字节直连 50ms vs 走 CF 1922ms，差 38 倍。详见 ADR-0005。

**换机器或换 IP 时**：① 改 DNSPod 里 `my-workspace` 的 A 记录指向新 IP；② 在新机器上装 acme.sh 重签证书（域名不变，泛域名照旧，装法与坑见下）。两步都不影响此时仍在服役的旧机器。

源站证书：`/opt/gateway/certs/{fullchain,privkey}.pem`。当前为 **Let's Encrypt 泛域名**（`*.324614917.xyz` + `324614917.xyz`），由 **acme.sh 自动续期**，不需要人工介入。

**签发与续期（已自动化，下面是原理与手工兜底）**

```bash
# 证书存放与续期计划
/root/.acme.sh/acme.sh --list          # 看到期与下次续期时间
crontab -l | grep acme                 # 每日 4 次（1/7/13/19 点）检查，到期前 30 天自动续

# 手工强制重签（一般用不到）
export DP_Id=<DNSPod ID>; export DP_Key=<DNSPod Token>
/root/.acme.sh/acme.sh --issue --dns dns_dp \
  -d 324614917.xyz -d '*.324614917.xyz' --server letsencrypt --keylength 2048
/root/.acme.sh/acme.sh --install-cert -d 324614917.xyz \
  --key-file /opt/gateway/certs/privkey.pem \
  --fullchain-file /opt/gateway/certs/fullchain.pem \
  --reloadcmd "chmod 600 /opt/gateway/certs/privkey.pem; chmod 644 /opt/gateway/certs/fullchain.pem; docker exec gateway nginx -t && docker exec gateway nginx -s reload"
```

**关键事实**
- API 凭据存在 `/root/.acme.sh/account.conf`（权限 600，键名 `SAVED_DP_Id` / `SAVED_DP_Key`），cron 续期自取，不需要环境变量。
- 续期后自动执行 `reloadcmd`：改权限 → `nginx -t` → `nginx -s reload`，无需重启容器。
- **acme.sh 自动升级已关闭**（`--auto-upgrade 0`）：服务器的 `raw.githubusercontent.com` 不可达（SSL_ERROR_SYSCALL），开着只会每天报错。
- 装 acme.sh 时也是因此绕的弯：源码包在本机下载后 scp 上传，不走服务器直连 GitHub。
- 证书备份：`certs.bak-trustasia-20261107/`（TrustAsia，已停用）、`certs.bak-20261107/`（更早的自签）。
- 泛域名意味着**以后新增子域不用再签证书**，只要在 DNSPod 加 A 记录并在网关加对应 `server_name`。

**根域 `324614917.xyz` 归 buddy**，网关的默认 server 块负责；别把它也指到工作台。

**排查口诀**：先问权威服务器，别看面板。
- 是否直连：`nslookup my-workspace.324614917.xyz` 应回 `139.224.192.94`；若回 `104.21.x` / `172.67.x`，说明仍在走 CF 代理或本地缓存未过期。
- 注册局怎么说：`curl https://rdap.centralnic.com/xyz/domain/324614917.xyz`（无缓存，比 DoH 可靠）。
- 证书是否生效：`openssl s_client -connect 139.224.192.94:443 -servername my-workspace.324614917.xyz | openssl x509 -noout -issuer`，应显示 Let's Encrypt 而非自签；同时看 SAN 是否含 `*.324614917.xyz`。
- DNSPod 显示「未使用云解析 DNS 地址」= 注册局 NS 与 DNSPod 分配的不一致；域名详情页悬停该状态可看到要求填写的 NS 对。

**已下线（2026-11-07，经确认不再使用）**：`api.324614917.xyz`（CNAME → `jiese-checkin.pages.dev`，Cloudflare Pages 绑定随 zone 迁出而失效）、`izzy-happybirthday.324614917.xyz`（生日页）。

## 鉴权

当前免登录，`/opt/workbench/.env` 只有一行 `AUTH=off`。

- **恢复登录**：`printf 'AUTH=basic\nAUTH_USER=joye\nAUTH_PASS=新密码\n' > .env` 后 `docker compose up -d`
- **兜底逻辑**：`AUTH` 不是 `off` 时，`AUTH_USER`/`AUTH_PASS` 任一为空容器直接退出——这是有意的，防止误删凭据把站点裸奔出去
- **`/api/health` 始终匿名**，供容器健康检查用，只返回 uptime

免登录意味着任何拿到 URL 的人都能读写你的安排。数据本身只有一份 `data.json`，被改坏了用 `.bak` 回滚。

## 日常更新

**线上是扁平布局**：`app/` 里的内容直接铺在 `/opt/workbench` 根目录（`server.js`、`public/`、`Dockerfile` 都在根上），构建上下文就是 `/opt/workbench`。所以**要传的是 `app/` 的内容，不是仓库根**。

```bash
cd app && npm run deploy
```

（打包目录、排除项、密钥、回退档、自查都在 `app/scripts/deploy.sh` 里，不要手写 tar/ssh。脚本依次做：静态自检 → 打回退档（`workbench:prev` + 数据备份）→ 从 `app/` 打包上传 → `docker compose up -d --build` → 比对容器内文件哈希与数据指纹 → 探公网。**打包目录与排除项错一个就是线上事故。**）

只改前端（`public/`）也要重建镜像，因为静态文件打在镜像里。

⚠️ **传错位置的症状**：如果把仓库根整棵树传上去，文件会落到 `/opt/workbench/app/public/`，而构建读的是根目录的 `public/` —— 此时 `docker compose up -d --build` 会输出 `COPY public ./public CACHED`、镜像 ID 不变、容器不重启，看起来"部署成功"但页面没变。**判据：镜像 sha256 有没有变、容器是不是 `Recreated`。**

部署后自查由脚本自动做（容器内文件哈希 ↔ 本机、数据指纹、公网 HTTP），结果会直接打印。

## 护栏（提交与发布前的自检）

仓库自带的脚本，别手写重复的验证：

| 命令 | 管什么 |
|---|---|
| `cd app && npm run check` | 语法、镜像 COPY 覆盖（新增目录忘了加 `COPY` 会在这里报）、行尾（工作区 CRLF 会被打进镜像） |
| `cd app && npm run smoke` | 端到端回归：改动前后两个版本的接口契约逐字比对、浏览器 DOM 归一化比对、首屏 500 的自动重试 |
| `cd app && npm run adr` | ADR 漂移：改了鉴权默认 / 磁盘格式 / 端口 / 镜像契约，却没新增 ADR 就报错 |
| `cd app && npm run deploy` | 部署（见上） |

提交前自动跑前两项：`git config core.hooksPath .githooks`（一次性启用）。CI 在每次 push / PR 上跑同样三项。

> 写脚本时踩过的坑，都固化在 `app/scripts/` 里了：两个服务必须在**同一次脚本调用**里启停（后台进程不跨命令存活）；基准版本要放在 `app/` 目录内（否则 `require('express')` 找不到 `node_modules`）；Node 不认 Git-Bash 的 `/tmp`（实为 `D:\tmp`），暂存目录一律用 `app/.smoke/`。

## 排障

```bash
docker compose -f /opt/workbench/docker-compose.yml ps
docker logs --tail 50 workbench
docker inspect --format '{{.State.Health.Status}}' workbench
curl -u joye:<密码> http://127.0.0.1:8090/api/health
```

健康检查失败先看 `docker logs`；`AUTH_USER`/`AUTH_PASS` 任一为空容器会直接退出（fail-closed，这是有意的）。

## 备份与恢复

```bash
# 备份（在服务器上，下载到本机也行）
cp /opt/workbench/data/data.json ~/workbench-$(date +%F).json

# 恢复：先停容器，替换文件，再起
docker stop workbench
cp ~/workbench-2026-11-05.json /opt/workbench/data/data.json
docker start workbench
```

也可以在浏览器里访问 `/api/export` 直接下载当前全量数据。

## 回滚

镜像每次构建都会覆盖 `workbench:latest`。要能回滚，构建前先打标签：

```bash
docker tag workbench:latest workbench:prev
docker compose up -d --build   # 出错时
docker tag workbench:prev workbench:latest && docker compose up -d
```

## 已知限制

- **源站 IP 直接暴露**，无 CDN/DDoS 防护（2026-11-07 起不再经 Cloudflare）。
- **证书靠 acme.sh 自动续**：cron 每天检查、到期前 30 天自动重签并 reload 网关；若 cron 或 DNSPod Token 失效，证书到期（90 天）后浏览器会报错，需查 `acme.sh --list` 与 `crontab -l`。
- **未备案域名直连国内服务器**，严格说不合规；长期解是 ICP 备案 + 腾讯云 EdgeOne。
- 单用户模型，没有账号体系；`data.json` 全量读写，多人并发会互相覆盖。
- 端口 8090 依赖阿里云**轻量应用服务器**的「防火墙」（不是 ECS 安全组，这台机器是 SWAS）；换端口要同时改 `docker-compose.yml` 与控制台防火墙规则。当前已放行：80 / 443 / 22 / ICMP / 8090。
