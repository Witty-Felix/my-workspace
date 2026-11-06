#!/usr/bin/env bash
# 静态自检：语法、镜像打包覆盖、行尾一致性。
# 任何一项不过就以退出码 1 结束，可直接挂 pre-commit 与 CI。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$APP/.." && pwd)"
cd "$APP"

fail=0
bad() { printf '  ✗ %s\n' "$*"; fail=1; }
ok()  { printf '  ✓ %s\n' "$*"; }

echo "== 1. 语法检查 =="
while IFS= read -r f; do
  if node --check "$f" >/dev/null 2>&1; then ok "$f"; else bad "$f 语法错误"; node --check "$f" 2>&1 | head -3 | sed 's/^/      /'; fi
done < <(find . -name node_modules -prune -o -name '*.js' -print | sed 's|^\./||' | sort)

echo
echo "== 2. 镜像必须打进去的东西 =="
# 运行时需要的四样：入口、依赖清单、领域与存储模块、静态资源
for rule in "COPY server.js ./" "COPY package.json ./" "COPY lib ./lib" "COPY public ./public"; do
  if grep -qF "$rule" Dockerfile; then ok "Dockerfile: $rule"; else bad "Dockerfile 缺：$rule"; fi
done
# app/ 下新增目录若没加 COPY 行，镜像构建会漏文件——这正是加 lib/ 时踩过的坑
while IFS= read -r d; do
  d="${d%/}"
  [ "$d" = "node_modules" ] && continue
  [ "$d" = "scripts" ] && continue
  [ "$d" = "data" ] && continue
  if grep -qF "COPY $d " Dockerfile; then ok "目录 $d 已加入镜像"; else bad "目录 $d 没有 COPY 行，镜像会缺它"; fi
done < <(find . -maxdepth 1 -mindepth 1 -type d -printf '%f\n' | sort)

echo
echo "== 3. 行尾（部署打包的是工作区，工作区必须 LF）==="
wcrlf="$(cd "$ROOT" && git ls-files --eol | awk '$2 != "w/lf" {print $NF}')"
icrlf="$(cd "$ROOT" && git ls-files --eol | awk '$1 != "i/lf" {print $NF}')"
if [ -n "$wcrlf" ]; then
  bad "工作区不是 LF（打包上传的就是它，CRLF 会带进镜像）"
  printf '%s\n' "$wcrlf" | sed 's/^/      /'
else
  ok "工作区全部 LF"
fi
if [ -n "$icrlf" ]; then
  bad "索引侧不是 LF"
  printf '%s\n' "$icrlf" | sed 's/^/      /'
else
  ok "索引侧全部 LF"
fi

echo
if [ "$fail" -ne 0 ]; then echo "✗ check 未通过"; exit 1; fi
echo "✓ check 全部通过"
