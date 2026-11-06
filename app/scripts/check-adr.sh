#!/usr/bin/env bash
# ADR 漂移检查：架构「事实」变了（鉴权默认、磁盘格式版本、端口、镜像运行时契约），
# 却没同步新增 ADR —— 这类改动过去会静悄悄地把 ADR 留在过期状态。
#
# 比对的是事实本身，不是文件列表：重构（挪文件、加 COPY 行）不算决策变更，
# 改行为（鉴权默认从 basic 变成免登录、磁盘版本 1→2）才算。
#
# 用法：
#   bash scripts/check-adr.sh            有漂移则退出码 1
#   bash scripts/check-adr.sh --warn     只提示，退出码 0（CI 用）
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$APP/.." && pwd)"
cd "$ROOT"

WARN_ONLY=0
[ "${1:-}" = "--warn" ] && WARN_ONLY=1

# 取某个版本的事实清单。顺序无关地同时看 server.js 与 lib/store.js，
# 这样重构把代码从 server.js 挪进 lib/ 时，两边抽出的事实仍然一致。
facts() {
  local rev="$1" blob
  blob="$(git show "$rev:app/server.js" 2>/dev/null; git show "$rev:app/lib/store.js" 2>/dev/null)"
  echo "鉴权默认=$(echo "$blob" | grep -oE "process\.env\.AUTH \|\| '[^']+'" | head -1 | grep -oE "'[^']+'" | tr -d "'")"
  echo "支持免登录=$(echo "$blob" | grep -c 'AUTH_OFF')"
  echo "磁盘版本=$(echo "$blob" | grep -oE 'CURRENT_VERSION = [0-9]+|version: [0-9]+' | head -1 | grep -oE '[0-9]+$')"
  echo "存储信封=$(echo "$blob" | grep -oE 'version: [A-Za-z_0-9]+, items' | head -1 | sed -E 's/version: [A-Za-z_0-9]+/version/')"
  echo "服务端口=$(echo "$blob" | grep -oE 'process\.env\.PORT \|\| [0-9]+' | head -1 | grep -oE '[0-9]+$')"
  echo "映射端口=$(git show "$rev:app/docker-compose.yml" 2>/dev/null | grep -oE '"[0-9]+:[0-9]+"' | tr '\n' ' ')"
  echo "镜像契约=$(git show "$rev:app/Dockerfile" 2>/dev/null | grep -E '^(EXPOSE|ENV)' | tr '\n' ';')"
  echo "鉴权环境=$(git show "$rev:app/docker-compose.yml" 2>/dev/null | grep -E 'AUTH' | tr '\n' ';')"
}

LAST_ADR="$(git log --diff-filter=A --format=%H -1 -- docs/adr/ 2>/dev/null)"
if [ -z "$LAST_ADR" ]; then
  echo "  – 仓库还没有任何 ADR，无法判定漂移"
  exit 0
fi

facts "$LAST_ADR" > /tmp/.adr-base.$$ 2>/dev/null
facts HEAD > /tmp/.adr-head.$$ 2>/dev/null

NEW_ADR="$(git log --diff-filter=A --name-only --format= "$LAST_ADR..HEAD" -- docs/adr/ 2>/dev/null | grep -v '^$' | sort -u)"

if diff -q /tmp/.adr-base.$$ /tmp/.adr-head.$$ >/dev/null 2>&1; then
  echo "  ✓ 自上次 ADR（$(git log -1 --format='%h %s' $LAST_ADR)）以来，架构事实未变"
  rm -f /tmp/.adr-base.$$ /tmp/.adr-head.$$
  exit 0
fi

if [ -n "$NEW_ADR" ]; then
  echo "  ✓ 架构事实有变更，且同期新增了 ADR：$(echo "$NEW_ADR" | tr '\n' ' ')"
  rm -f /tmp/.adr-base.$$ /tmp/.adr-head.$$
  exit 0
fi

echo "  ✗ 架构事实变了，却没有新增 ADR："
diff /tmp/.adr-base.$$ /tmp/.adr-head.$$ | sed 's/^/      /'
echo
echo "      这些改动等于改了架构决定，ADR 会静悄悄留在过期状态"
echo "      （ADR-0002 就这样过期过：文档写着 Basic Auth，生产早已 AUTH=off）。"
echo "      处理：新增 docs/adr/00XX-*.md，并在被取代的 ADR 顶部标注 amended/superseded。"
rm -f /tmp/.adr-base.$$ /tmp/.adr-head.$$
if [ "$WARN_ONLY" -eq 1 ]; then
  echo "  （--warn 模式：仅提示）"
  exit 0
fi
exit 1
