#!/usr/bin/env bash
# 文档事实检查：docs/deploy.md 是「线上现状」的唯一描述，一旦和事实漂移，
# 后来的人（包括 agent）会照着错的描述操作。ADR 不扫 —— ADR 是历史记录，
# 本来就该谈论 Cloudflare / TrustAsia 这些已经改掉的东西。
#
# 词表是「当前事实」的缓存：事实再变（备案 + 迁 EdgeOne）时要同步改这张表，
# 否则护栏本身会过期。
#
# 用法：
#   bash scripts/check-docs.sh              有漂移则退出码 1
#   bash scripts/check-docs.sh --warn       只提示，退出码 0（CI 用）
#   bash scripts/check-docs.sh --self-test  用假文档验证检查本身可信
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$APP/.." && pwd)"
cd "$ROOT"

DOC="docs/deploy.md"

# 断言了「已不成立的状态」的词。只放会让人按错前提操作的表述。
BANNED='纯 HTTP|橙云|Proxied|Universal SSL|边缘证书'

# 必须存在于现状描述里的正向事实，防「整段被删」这种反向漂移。
REQUIRED=(
  "deer.dnspod.net"
  "false.dnspod.net"
  "Let's Encrypt"
  "acme.sh"
  "139.224.192.94"
)

fail=0
bad() { printf '  ✗ %s\n' "$*"; fail=1; }
ok()  { printf '  ✓ %s\n' "$*"; }

# 对一份文档跑全部检查。返回 0 表示干净。
check_doc() {
  local doc="$1" hits rc=0

  if [ ! -f "$doc" ]; then
    printf '  ✗ 找不到 %s\n' "$doc" >&2
    return 1
  fi

  hits="$(grep -nE "$BANNED" "$doc" || true)"
  if [ -n "$hits" ]; then
    printf '  ✗ %s 出现已过时的表述：\n' "$doc" >&2
    printf '%s\n' "$hits" | sed 's/^/      /' >&2
    printf '      改法：按当前事实重写该句（入口=DNSPod 直连 + HTTPS；证书=Let'"'"'s Encrypt + acme.sh）\n' >&2
    rc=1
  fi

  # TrustAsia 只在备份目录这种历史事实上才允许出现
  hits="$(grep -n 'TrustAsia' "$doc" | grep -v 'certs.bak-trustasia' || true)"
  if [ -n "$hits" ]; then
    printf '  ✗ %s 提到 TrustAsia，但它已不是当前证书：\n' "$doc" >&2
    printf '%s\n' "$hits" | sed 's/^/      /' >&2
    printf '      改法：当前是 Let'"'"'s Encrypt；只有备份目录名可保留 TrustAsia 字样\n' >&2
    rc=1
  fi

  local s
  for s in "${REQUIRED[@]}"; do
    if ! grep -qF -- "$s" "$doc"; then
      printf '  ✗ %s 缺少事实：%s\n' "$doc" "$s" >&2
      rc=1
    fi
  done

  return "$rc"
}

ST_TMP=""
trap 'rm -rf "${ST_TMP:-}"' EXIT

self_test() {
  local rc=0 good bad
  ST_TMP="$(mktemp -d)"
  good="$ST_TMP/good.md"
  bad="$ST_TMP/bad.md"
  printf 'NS deer.dnspod.net / false.dnspod.net\n证书 Let'"'"'s Encrypt\nacme.sh 自动续\n源站 139.224.192.94\n备份 certs.bak-trustasia-20261107/\n' > "$good"
  printf '纯 HTTP，证书 TrustAsia\n' > "$bad"

  if check_doc "$good" >/dev/null 2>&1; then
    echo "  ✓ 自测：干净的文档被判为通过"
  else
    echo "  ✗ 自测：干净的文档被误判"; rc=1
  fi

  if check_doc "$bad" >/dev/null 2>&1; then
    echo "  ✗ 自测：有漂移的文档没被抓到"; rc=1
  else
    echo "  ✓ 自测：有漂移的文档被抓到"
  fi

  return "$rc"
}

echo "== 文档事实检查（$DOC）=="

if [ "${1:-}" = "--self-test" ]; then
  if self_test; then echo "✓ 自测全部通过"; exit 0; fi
  echo "✗ 自测未通过"
  exit 1
fi

check_doc "$DOC" || fail=1
[ "$fail" -eq 0 ] && ok "未发现过时表述，正向事实齐全"

echo
if [ "$fail" -ne 0 ]; then
  if [ "${1:-}" = "--warn" ]; then
    echo "  （--warn 模式：仅提示）"
    exit 0
  fi
  echo "✗ 文档事实检查未通过"
  exit 1
fi
echo "✓ 文档事实检查通过"
