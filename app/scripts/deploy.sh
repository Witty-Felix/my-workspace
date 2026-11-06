#!/usr/bin/env bash
# 部署到生产服务器的单一真相源 —— 文档不要再复述这些命令，只指向这里。
#
# 用法：
#   bash scripts/deploy.sh --dry-run    只打印将要做什么，不连服务器
#   bash scripts/deploy.sh               真部署
#
# 可覆盖的环境变量：
#   DEPLOY_HOST  服务器（默认 139.224.192.94）
#   DEPLOY_KEY   部署密钥（默认 ~/.ssh/wb_deploy_ed25519）
#   DEPLOY_PATH  服务器上的目标目录（默认 /opt/workbench）
#   PUBLIC_URL   公网地址（默认 https://my-workspace.324614917.xyz/）
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"

HOST="${DEPLOY_HOST:-139.224.192.94}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/wb_deploy_ed25519}"
REMOTE="${DEPLOY_PATH:-/opt/workbench}"
PUBLIC="${PUBLIC_URL:-https://my-workspace.324614917.xyz/}"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

SSH="ssh -i $KEY -o IdentitiesOnly=yes -o ConnectTimeout=15 root@$HOST"

run() {  # 远端命令
  if [ "$DRY" -eq 1 ]; then echo "  [dry-run] ssh … $1"; else $SSH "$1"; fi
}
runlocal() {  # 本机命令
  if [ "$DRY" -eq 1 ]; then echo "  [dry-run] $*"; else eval "$@"; fi
}

echo "== 0. 前置检查 =="
if bash "$HERE/check.sh"; then :; else
  echo "✗ check 未通过，不部署"; exit 1
fi
[ -f "$KEY" ] || { echo "✗ 找不到部署密钥 $KEY"; exit 1; }

echo
echo "== 1. 建立回退档 =="
run "cd $REMOTE && docker tag workbench:latest workbench:prev && docker images workbench --format '{{.Tag}} {{.ID}}'"
run "cd $REMOTE && cp -a data/data.json data/data.json.deploy-\$(date +%Y%m%d-%H%M%S) && ls -la data/"

echo
echo "== 2. 上传（从 app/ 打包，不是仓库根）==="
# 打包目录必须是 app/：线上是扁平布局，server.js / public/ 直接铺在 $REMOTE 根上。
# 三个排除项缺一不可：node_modules 不传、data 不传（生产数据）、.env 不传（生产鉴权配置）。
echo "  打包 app/ → $HOST:$REMOTE"
if [ "$DRY" -eq 0 ]; then
  (cd "$APP" && tar czf - --exclude=./node_modules --exclude=./data --exclude=./.env .) \
    | $SSH "tar xzf - -C $REMOTE" || { echo "✗ 上传失败"; exit 1; }
  echo "  上传完成"
fi

echo
echo "== 3. 重建镜像并重启容器 =="
run "cd $REMOTE && docker compose up -d --build 2>&1 | tail -15"
run "cd $REMOTE && docker images workbench --format '{{.Tag}} {{.ID}} {{.CreatedSince}}' && docker ps --filter name=workbench --format '{{.Names}} {{.Status}} {{.Image}}'"

echo
echo "== 4. 自查三条 =="
# ① 容器里的文件必须与本机逐字节一致
if [ "$DRY" -eq 0 ]; then
  for f in server.js lib/domain.js lib/store.js public/index.html public/app.js public/style.css; do
    local_sum="$(md5sum "$APP/$f" | cut -d' ' -f1)"
    remote_sum="$($SSH "docker exec workbench md5sum /app/$f" 2>/dev/null | cut -d' ' -f1)"
    if [ "$local_sum" = "$remote_sum" ]; then
      echo "  ✓ $f 哈希一致 $local_sum"
    else
      echo "  ✗ $f 不一致：本机 $local_sum / 容器 $remote_sum"; exit 1
    fi
  done
  # ② 生产数据不能被动过
  $SSH "md5sum $REMOTE/data/data.json"
  # ③ 公网能拿到新内容
  $SSH "curl -s -o /dev/null -w '  公网 HTTP %{http_code}\n' $PUBLIC"
else
  echo "  [dry-run] 比对容器内 md5 / 数据指纹 / 公网 HTTP"
fi

echo
echo "完成。回滚命令（未自动执行，按需手动跑）："
echo "  ssh -i $KEY root@$HOST \"docker tag workbench:prev workbench:latest && cd $REMOTE && docker compose up -d --force-recreate\""
