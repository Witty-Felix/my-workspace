#!/usr/bin/env bash
# 端到端回归：把「基准版本」和「当前工作区」两个版本并排跑，比对三件事——
#   1. 接口契约：同一套请求序列的响应体与状态码逐字相同
#   2. 渲染结果：浏览器里 dump 出的 DOM 归一化后相同
#   3. 首屏重试：首屏 500 时自动重试一次，持续 500 时不死循环
#
# 用法：bash scripts/smoke.sh [基准 ref]     默认基准 = HEAD（即工作区 vs 上一次提交）
# 说明：两个服务都在本脚本这一次调用里启停 —— 后台进程不跨命令存活，必须同批启停。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$APP/.." && pwd)"
BASE_REF="${1:-HEAD}"

OLD_PORT=8181
NEW_PORT=8182
MOCK_PORT=8183
SCRATCH="$APP/.smoke"

fail=0
bad() { printf '  ✗ %s\n' "$*"; fail=1; }
ok()  { printf '  ✓ %s\n' "$*"; }
skip() { printf '  – %s\n' "$*"; }

# 有意变更的基线：diff 正文（去掉带时间戳与路径的文件头）与 scripts/*-accepted.diff
# 逐字相同就放行；SMOKE_ACCEPT=1 时把当前正文写成新基线 —— 那次提交里就能看见「基线变了什么」。
accept_diff() { # $1=diff 文件  $2=基线文件  $3=名字
  local body
  body="$(tail -n +3 "$1")"
  if [ -f "$2" ] && [ "$body" = "$(cat "$2")" ]; then
    ok "$3 的变更是已接受的基线（见 ${2#"$ROOT"/}）"
    return 0
  fi
  if [ "${SMOKE_ACCEPT:-0}" = "1" ]; then
    printf '%s\n' "$body" > "$2"
    ok "$3 的新基线已写入 ${2#"$ROOT"/}（记得随代码一起提交）"
    return 0
  fi
  return 1
}

cleanup() {
  for p in $OLD_PID $NEW_PID $MOCK_PID; do
    [ -n "${p:-}" ] && kill "$p" 2>/dev/null
  done
  wait 2>/dev/null
  # node 进程退出后文件句柄才释放，Windows 上此时还删不掉目录
  for i in 1 2 3 4 5; do
    rm -rf "$SCRATCH" 2>/dev/null && break
    sleep 0.5
  done
}
trap cleanup EXIT

echo "== 准备 =="
rm -rf "$SCRATCH" 2>/dev/null
mkdir -p "$SCRATCH/old/public" "$SCRATCH/old/lib" "$SCRATCH/data-old" "$SCRATCH/data-new"

# 基准版本要放在 app/ 里面，否则 require('express') 找不到 node_modules
if ! git -C "$ROOT" show "$BASE_REF:app/server.js" > "$SCRATCH/old/server.js" 2>/dev/null; then
  echo "✗ 取不到基准 $BASE_REF:app/server.js"; exit 2
fi
for f in index.html app.js style.css; do
  git -C "$ROOT" show "$BASE_REF:app/public/$f" > "$SCRATCH/old/public/$f" 2>/dev/null || true
done
# 基准版本若有 lib/，按原结构取出（服务端 require 与 /domain.js 路由都指向它）
git -C "$ROOT" show "$BASE_REF:app/lib/domain.js" > "$SCRATCH/old/lib/domain.js" 2>/dev/null || rm -f "$SCRATCH/old/lib/domain.js"
git -C "$ROOT" show "$BASE_REF:app/lib/store.js" > "$SCRATCH/old/lib/store.js" 2>/dev/null || rm -f "$SCRATCH/old/lib/store.js"

node "$HERE/lib/fixture.js" "$SCRATCH/data-old/data.json" >/dev/null
node "$HERE/lib/fixture.js" "$SCRATCH/data-new/data.json" >/dev/null
# shellcheck disable=SC1091
. "$SCRATCH/data-old/range.env"
export FROM TO
ok "基准 $BASE_REF，查询区间 $FROM ~ $TO"

echo
echo "== 1. 接口契约逐字比对 =="
# exec：让 $! 拿到 node 本体的 PID，否则 kill 杀不到真正占着文件的进程
(cd "$APP" && exec env PORT=$OLD_PORT AUTH=off DATA_DIR="$SCRATCH/data-old" node "$SCRATCH/old/server.js" > "$SCRATCH/old.log" 2>&1) & OLD_PID=$!
(cd "$APP" && exec env PORT=$NEW_PORT AUTH=off DATA_DIR="$SCRATCH/data-new" node server.js > "$SCRATCH/new.log" 2>&1) & NEW_PID=$!
for i in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$OLD_PORT/api/health" >/dev/null 2>&1 && \
  curl -sf "http://127.0.0.1:$NEW_PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.25
done
if ! curl -sf "http://127.0.0.1:$NEW_PORT/api/health" >/dev/null 2>&1; then
  echo "  ✗ 新版服务没起来"; sed 's/^/      /' "$SCRATCH/new.log"; exit 1
fi
if ! curl -sf "http://127.0.0.1:$OLD_PORT/api/health" >/dev/null 2>&1; then
  echo "  ✗ 基准服务没起来"; sed 's/^/      /' "$SCRATCH/old.log"; exit 1
fi
node "$HERE/lib/contract.js" "http://127.0.0.1:$OLD_PORT" > "$SCRATCH/seq-old.txt" 2>&1
node "$HERE/lib/contract.js" "http://127.0.0.1:$NEW_PORT" > "$SCRATCH/seq-new.txt" 2>&1
if diff -u "$SCRATCH/seq-old.txt" "$SCRATCH/seq-new.txt" > "$SCRATCH/seq.diff"; then
  ok "接口契约逐字一致（$(wc -l < "$SCRATCH/seq-new.txt") 条调用）"
elif accept_diff "$SCRATCH/seq.diff" "$APP/scripts/contract-accepted.diff" "接口契约"; then
  :
else
  bad "接口契约变了"; head -30 "$SCRATCH/seq.diff" | sed 's/^/      /'
fi

echo
echo "== 2. 渲染结果比对 =="
BROWSER=""
for c in "${EDGE:-}" "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
         "/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
         "/c/Program Files/Google/Chrome/Application/chrome.exe" \
         "/usr/bin/google-chrome" "/usr/bin/chromium-browser" "/usr/bin/chromium"; do
  [ -n "$c" ] && [ -f "$c" ] && BROWSER="$c" && break
done
if [ -z "$BROWSER" ]; then
  skip "没找到浏览器，跳过 DOM 比对"
else
  dump() { # 归一化：去掉标签间空白与空行，跳过 head 里的构建细节（script/link）
    # script 整段跳过（含内联脚本），link 单行跳过 —— 比对的是「渲染出了什么」，
    # 不是「用了什么构建方式」。script 挂掉由下面第 3 项（卡片数）兜底。
    "$BROWSER" --headless=new --disable-gpu --virtual-time-budget=6000 --dump-dom "$1" 2>/dev/null \
      | sed 's/></>\n</g' | grep -v '^[[:space:]]*$' \
      | awk '{
          if (skip) { if ($0 ~ /<\/script>/) skip=0; next }
          if ($0 ~ /<script/) { if ($0 !~ /<\/script>/) skip=1; next }
          if (skipc) { if ($0 ~ /-->/) skipc=0; next }
          if ($0 ~ /^<!--/) { if ($0 !~ /-->/) skipc=1; next }
          if ($0 ~ /^<link /) next
          gsub(/^[ \t]+|[ \t]+$/, ""); print
        }'
  }
  dump "http://127.0.0.1:$OLD_PORT/" > "$SCRATCH/dom-old.txt"
  dump "http://127.0.0.1:$NEW_PORT/" > "$SCRATCH/dom-new.txt"

  # 有的机器上 --dump-dom 会吐空：两个空文件 diff 也「一致」，那种一致不能算数。
  # 换 CDP 再取一次；后面的重试用例也沿用这个模式，免得先白跑一遍把 mock 的次数耗掉。
  if [ "$(grep -c 'class="card[ "]' "$SCRATCH/dom-new.txt" || true)" -eq 0 ]; then
    DUMP_CDP=1
    node "$HERE/lib/dump-dom.mjs" "http://127.0.0.1:$NEW_PORT/" > "$SCRATCH/dom-new.txt" 2>/dev/null || true
    node "$HERE/lib/dump-dom.mjs" "http://127.0.0.1:$OLD_PORT/" > "$SCRATCH/dom-old.txt" 2>/dev/null || true
  fi

  if [ "$(grep -c 'class="card[ "]' "$SCRATCH/dom-new.txt" || true)" -eq 0 ]; then
    bad "浏览器没渲染出内容（dump 为空），这次比对不算数"
  elif diff -u "$SCRATCH/dom-old.txt" "$SCRATCH/dom-new.txt" > "$SCRATCH/dom.diff"; then
    ok "DOM 归一化后一致（日列 $(grep -c 'class="day[ "]' "$SCRATCH/dom-new.txt") / 卡片 $(grep -c 'class="card[ "]' "$SCRATCH/dom-new.txt")）"
  elif accept_diff "$SCRATCH/dom.diff" "$APP/scripts/dom-accepted.diff" "渲染结果"; then
    :
  else
    bad "DOM 变了"; head -30 "$SCRATCH/dom.diff" | sed 's/^/      /'
  fi
fi

echo
echo "== 3. 首屏失败重试 =="
node "$HERE/lib/mock.js" "$MOCK_PORT" once "$NEW_PORT" > "$SCRATCH/mock.log" 2>&1 & MOCK_PID=$!
sleep 1
if [ -n "$BROWSER" ]; then
  if [ "${DUMP_CDP:-0}" = "1" ]; then
    node "$HERE/lib/dump-dom.mjs" "http://127.0.0.1:$MOCK_PORT/" > "$SCRATCH/retry.html" 2>/dev/null || true
  else
    "$BROWSER" --headless=new --disable-gpu --virtual-time-budget=6000 --dump-dom "http://127.0.0.1:$MOCK_PORT/" 2>/dev/null > "$SCRATCH/retry.html"
  fi
  cards="$(grep -o 'class="card[ "]' "$SCRATCH/retry.html" | wc -l | tr -d ' ')"
  hits="$(curl -s "http://127.0.0.1:$MOCK_PORT/hits")"
  if [ "$cards" -gt 0 ] && [ "$hits" -le 2 ]; then
    ok "首屏 500 后自动重试成功（卡片 $cards，请求 $hits 次）"
  else
    bad "重试没生效（卡片 $cards，请求 $hits 次）"
  fi
  # 持续失败：只该试两次，然后报错，不能死循环
  kill $MOCK_PID 2>/dev/null; wait $MOCK_PID 2>/dev/null
  node "$HERE/lib/mock.js" "$MOCK_PORT" always "$NEW_PORT" > "$SCRATCH/mock2.log" 2>&1 & MOCK_PID=$!
  sleep 1
  "$BROWSER" --headless=new --disable-gpu --virtual-time-budget=3000 --dump-dom "http://127.0.0.1:$MOCK_PORT/" 2>/dev/null > "$SCRATCH/fail.html"
  cards="$(grep -o 'class="card[ "]' "$SCRATCH/fail.html" | wc -l | tr -d ' ')"
  hits="$(curl -s "http://127.0.0.1:$MOCK_PORT/hits")"
  toast="$(grep -o 'class="toast' "$SCRATCH/fail.html" | wc -l | tr -d ' ')"
  if [ "$cards" -eq 0 ] && [ "$hits" -le 2 ]; then
    ok "持续失败时不死循环（请求 $hits 次，错误提示 $toast 处）"
  else
    bad "持续失败时行为不对（卡片 $cards，请求 $hits 次）"
  fi
else
  skip "没找到浏览器，跳过重试验证"
fi

echo
if [ "$fail" -ne 0 ]; then echo "✗ smoke 未通过"; exit 1; fi
echo "✓ smoke 全部通过（基准 $BASE_REF）"
