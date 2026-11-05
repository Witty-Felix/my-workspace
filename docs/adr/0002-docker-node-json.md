# 部署形态：Docker 单容器 + Node 20 + Express + JSON 文件

workbench 作为独立 compose 服务运行（`node:20-alpine`），映射宿主 8090，数据目录挂载到 `/opt/workbench/data`。改这么定是因为实测发现服务器上**没有 nginx、没有 PHP**，`:80` 由 `docker-proxy` 占着跑 `vbcd` 五容器栈——原定的「宝塔 PHP 站点」在这台机器上根本立不起来。

## Considered Options

- **在宝塔里装 nginx + PHP**：80 已被 docker 占用，nginx 只能改听非标端口，为一个小工具多养一套运行栈和约 200 MB 内存，而这台机器总共只有 1.8 GB。
- **Python 3.6 标准库自写 HTTP 服务**：省掉镜像与 40 MB 内存，但请求解析、路由、错误处理全要自己担，安全面靠手写。
- **塞进现有 `vbcd-web` 的 nginx 配置**：省一个端口，但把工作台耦合进别人的 compose 与配置目录，对方升级时互相绊。

## Consequences

阿里云安全组需新开 `8090/TCP`——这是本方案唯一需要手工介入的环节。HTTP 明文配应用内 Basic Auth（不再是宝塔的「网站访问限制」，那功能这台机器没有）；等域名与 ICP 备案到位，再在同一容器前加 443 终止。
