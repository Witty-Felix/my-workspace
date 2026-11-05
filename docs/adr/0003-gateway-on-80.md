# 80 端口改由网关统一分发，buddy 退到 127.0.0.1:8080

服务器 `:80` 原本被 buddy 的 web 容器独占，而它的 nginx 配置是打进镜像的（`build: ./web`，容器无配置挂载），没法零侵入地加一条 `location`。为了让工作台拿到一个不必记端口的地址，新增 `gateway` 容器占据 80：`/workbench/` 转发到 `workbench:8090`，其余全部转给 `web:80`；buddy 的端口映射改为 `127.0.0.1:8080:80`，它的镜像与源码一行未动。

## Considered Options

- **改 buddy 的 `web/nginx.conf` 并重建镜像**：改动落在另一个项目的仓库里，且他日后重建镜像会覆盖，等于埋雷。
- **`docker cp` 把配置塞进运行中的 web 容器**：零改动，但容器一被重建路由就静默消失，表现为莫名其妙的 404。
- **维持 `8090` 独立端口**：零风险，但地址难记，且每加一个服务就多记一个端口。

## Consequences

多了一跳反代，buddy 的 `/api/kb/stream` 是 SSE，网关里必须 `proxy_buffering off`，否则打字机效果失效。80 归属 gateway 容器后，buddy 自身重启不影响入口；反过来 gateway 挂了两个站一起挂。buddy 目录的 `docker-compose.yml` 现在处于 modified 状态，若日后 `git pull` 拿到上游新版本，需要重新合并那一行端口映射。
