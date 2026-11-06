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
  dump() { # 归一化：去掉标签间空白与空行，丢掉 domain.js 脚本标签（含它的闭合标签）
    "$BROWSER" --headless=new --disable-gpu --virtual-time-budget=6000 --dump-dom "$1" 2>/dev/null \
      | sed 's/></>\n</g' | grep -v '^[[:space:]]*$' \
      | awk '{ if (skip) { skip=0; next } if ($0 ~ /<script src="domain.js">/) { skip=1; next } gsub(/^[ \t]+|[ \t]+$/, ""); print }'
  }
  dump "http://127.0.0.1:$OLD_PORT/" > "$SCRATCH/dom-old.txt"
  dump "http://127.0.0.1:$NEW_PORT/" > "$SCRATCH/dom-new.txt"
  if diff -u "$SCRATCH/dom-old.txt" "$SCRATCH/dom-new.txt" > "$SCRATCH/dom.diff"; then
    ok "DOM 归一化后一致（日列 $(grep -c 'class="day[ "]' "$SCRATCH/dom-new.txt") / 卡片 $(grep -c 'class="card[ "]' "$SCRATCH/dom-new.txt")）"
  else
    bad "DOM 变了"; head -30 "$SCRATCH/dom.diff" | sed 's/^/      /'
  fi
fi

echo
echo "== 3. 首屏失败重试 =="
node "$HERE/lib/mock.js" "$MOCK_PORT" once "$NEW_PORT" > "$SCRATCH/mock.log" 2>&1 & MOCK_PID=$!
sleep 1
if [ -n "$BROWSER" ]; then
  "$BROWSER" --headless=new --disable-gpu --virtual-time-budget=6000 --dump-dom "http://127.0.0.1:$MOCK_PORT/" 2>/dev/null > "$SCRATCH/retry.html"
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
