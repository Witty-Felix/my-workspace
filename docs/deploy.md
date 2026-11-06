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
| 访问 | **`https://my-workspace.324614917.xyz/`**（Cloudflare → 源站 80/443 → 网关 → 工作台） |
| 备用入口 | `http://139.224.192.94/workbench/`、`http://139.224.192.94:8090/` |
| 网关 | `gateway` 容器（`nginx:alpine`），配置在 `/opt/gateway`，同仓库 `deploy/gateway/` |
| 登录 | **已关闭**（`.env` 里 `AUTH=off`）。恢复登录：把 `.env` 改成 `AUTH=basic` + 填 `AUTH_USER`/`AUTH_PASS`，再 `docker compose up -d` |

## 首次部署（已完成，留档）

```bash
# 本机
tar czf - --exclude=node_modules --exclude=.smoke-data . \
  | ssh root@139.224.192.94 "mkdir -p /opt/workbench && tar xzf - -C /opt/workbench"

# 服务器
cd /opt/workbench
printf 'AUTH_USER=joye\nAUTH_PASS=<密码>\n' > .env && chmod 600 .env
docker compose up -d --build
```

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

## 子域名接入（Cloudflare）

**已接通。** 真实域名是 `324614917.xyz`（9 位数字）。早期排查用的 `3246146917.xyz`（10 位）从未在注册局存在，纯属多打一位，配置里仅保留作占位。

| 项 | 状态 |
|---|---|
| 域名 | `324614917.xyz`，腾讯云注册（注册商帝思普），Cloudflare 托管，橙云 Proxied |
| NS | `stanley` / `amalia.ns.cloudflare.com`（正确） |
| 子域记录 | `my-workspace` A → `139.224.192.94`，橙色云 |
| 边缘证书 | Cloudflare Universal SSL，Let's Encrypt 签发，浏览器直接信任 |
| 回源 | Cloudflare → 源站 80/443 → `gateway` 按 `server_name` 命中工作台 |

源站证书：`/opt/gateway/certs/{fullchain,privkey}.pem`，自签、10 年，SAN 含 `my-workspace.324614917.xyz`、`324614917.xyz`。要换成 Cloudflare Origin CA 证书并把 SSL 模式提到 `Full (strict)` 时，替换两个文件后 `docker compose up -d --force-recreate`（不是 reload，见上面的 inode 坑）。

**根域 `324614917.xyz` 归 buddy**，网关的默认 server 块负责；别把它也指到工作台。

**排查口诀**：先问权威服务器，别看面板。
`nslookup -type=ns <域名> ns0.centralnic.net` —— 注册局自己有话说，面板只显示“提交成功”。

## 鉴权

当前免登录，`/opt/workbench/.env` 只有一行 `AUTH=off`。

- **恢复登录**：`printf 'AUTH=basic\nAUTH_USER=joye\nAUTH_PASS=新密码\n' > .env` 后 `docker compose up -d`
- **兜底逻辑**：`AUTH` 不是 `off` 时，`AUTH_USER`/`AUTH_PASS` 任一为空容器直接退出——这是有意的，防止误删凭据把站点裸奔出去
- **`/api/health` 始终匿名**，供容器健康检查用，只返回 uptime

免登录意味着任何拿到 URL 的人都能读写你的安排。数据本身只有一份 `data.json`，被改坏了用 `.bak` 回滚。

## 日常更新

```bash
# 本机改完 → 传上去 → 重建
tar czf - --exclude=node_modules --exclude=.smoke-data . \
  | ssh root@139.224.192.94 "tar xzf - -C /opt/workbench"
ssh root@139.224.192.94 "cd /opt/workbench && docker compose up -d --build"
```

只改前端（`public/`）也要重建镜像，因为静态文件打在镜像里。

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

- 纯 HTTP，Basic Auth 凭据在链路上是 base64，只能防君子。域名与 ICP 备案到位后应加 443。
- 单用户模型，没有账号体系；`data.json` 全量读写，多人并发会互相覆盖。
- 端口 8090 依赖阿里云**轻量应用服务器**的「防火墙」（不是 ECS 安全组，这台机器是 SWAS）；换端口要同时改 `docker-compose.yml` 与控制台防火墙规则。当前已放行：80 / 443 / 22 / ICMP / 8090。
