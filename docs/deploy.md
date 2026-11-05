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
| 访问 | `http://139.224.192.94:8090`（需在轻量应用服务器控制台的「防火墙」放行 8090/TCP） |
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
