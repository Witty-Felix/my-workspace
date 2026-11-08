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
  # 隐藏目录是脚本自己的临时空间（.smoke / .drag-smoke），不进镜像也不该要求 COPY
  case "$d" in .*) continue;; esac
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
echo "== 4. 行内语句（大括号后不要挤代码）==="
# node --check 只认语法，看不出「换行被吃掉、语句挤进同一行」这种伤。
# 一行式 try/catch 是本仓库的既有写法（`{ ... }` 里只隔一个空格），
# 所以只在「大括号后跟两个以上空格再接内容」时报警——那几乎总是丢了换行。
inlined="$(while IFS= read -r f; do
  awk 'match($0, /\{[ \t][ \t]+[^ \t]/) { printf "%s:%d\n", FILENAME, FNR }' "$f"
done < <(find . -name node_modules -prune -o -name '*.js' -print | sed 's|^\./||' | sort))"
if [ -n "$inlined" ]; then
  bad "有大括号后直接挤了语句的行"
  printf '%s\n' "$inlined" | sed 's/^/      /'
else
  ok "没有挤在一行的大括号"
fi

echo
echo "== 5. 词表禁词（手写黑名单，不解析 GLOSSARY）=="
# _Avoid_ 里混着「周」「week」这类常用词，解析词表会误报；这里只盯几个
# 一定不该出现在代码与界面文案里的词。
banned='看板|待办|日程|投放位|drop zone'
hits="$(grep -rnE "$banned" --include='*.js' --include='*.html' --include='*.css' \
  --exclude-dir=node_modules --exclude-dir=data --exclude-dir=.smoke \
  --exclude-dir=.drag-smoke --exclude-dir=.done-smoke . 2>/dev/null || true)"
if [ -n "$hits" ]; then
  bad "出现词表禁词："
  printf '%s\n' "$hits" | head -10 | sed 's/^/      /'
else
  ok "没有词表禁词"
fi

echo
if [ "$fail" -ne 0 ]; then echo "✗ check 未通过"; exit 1; fi
echo "✓ check 全部通过"
