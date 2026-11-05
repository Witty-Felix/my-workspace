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
| 访问 | **`http://139.224.192.94/workbench/`**（80 由 gateway 容器按路径分发） |
| 备用入口 | `http://139.224.192.94:8090/`（直连 workbench，绕过网关） |
| 网关 | `gateway` 容器（`nginx:alpine`），配置在 `/opt/gateway`，同仓库 `deploy/gateway/` |
| 登录 | HTTP Basic，凭据在 `/opt/workbench/.env`（`/api/health` 例外，匿名可访问，供容器探针用） |

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
scp deploy/gateway/nginx.conf root@139.224.192.94:/opt/gateway/
ssh root@139.224.192.94 "docker exec gateway nginx -t && docker exec gateway nginx -s reload"
```

buddy 那侧的端口映射已改为 `127.0.0.1:8080:80`（在 `/home/bird/vbcd/docker-compose.yml`，改前备份为 `docker-compose.yml.bak-*`）。**它不是本仓库的文件**，日后 buddy 若拉上游新版本，需要重新合并这一行。

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
