#!/usr/bin/env bash
# 飞车 3D · 在线对战一键部署（本机 / 局域网）
#
#   ./deploy.sh              构建并启动（默认），打印局域网分享地址
#   ./deploy.sh start        同上，可加 --smoke 先跑测试门禁
#   ./deploy.sh stop         停掉由本脚本启动的服务
#   ./deploy.sh status       进程/端口/房间数
#   ./deploy.sh admin        打印后台运维台地址与访问口令
#   ./deploy.sh smoke        只跑 Node 侧回归（不启动服务）
#   ./deploy.sh build        只重新构建 dist
#   ./deploy.sh restart      stop + start
#   ./deploy.sh log          跟踪服务器日志
#
# 环境变量：PORT=8790  HOST_BIND=0.0.0.0  BUN=/path/to/bun  ADMIN_TOKEN=自定义后台口令
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
TMP="$ROOT/.tmp"
mkdir -p "$TMP"
PIDF="$TMP/deploy.pid"
PORTF="$TMP/deploy.port"
LOGF="$TMP/server.log"
BUILD_ID="qq-speed-net-v1"
WANT_PORT="${PORT:-8790}"

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# ---------- bun：这台机器上 bun 常常不在 PATH 里 ----------
find_bun() {
  if [ -n "${BUN:-}" ] && [ -x "${BUN//\"/}" ]; then printf '%s' "${BUN//\"/}"; return 0; fi
  if command -v bun >/dev/null 2>&1; then command -v bun; return 0; fi
  for c in "$HOME/.bun/bin/bun" "$HOME/.bun/bin/bun.exe" "/c/Users/$USERNAME/.bun/bin/bun.exe" "$HOME/scoop/shims/bun.exe"; do
    [ -x "$c" ] && { printf '%s' "$c"; return 0; }
  done
  return 1
}
BUN_BIN="$(find_bun || true)"
[ -n "$BUN_BIN" ] || die "找不到 bun。安装：curl -fsSL https://bun.sh/install | bash，或用 BUN=/path/to/bun ./deploy.sh"

# ---------- 探活：用构建指纹，避免命中上一轮残留的旧进程 ----------
health() {
  local p="$1"
  curl -fsS --max-time 2 "http://127.0.0.1:$p/healthz" 2>/dev/null || true
}
is_ours() { case "$1" in *"$BUILD_ID"*) return 0 ;; *) return 1 ;; esac; }

port_in_use() { [ -n "$(health "$1")" ]; }

pick_port() {
  # 首选 WANT_PORT；被别的程序占了就往后找；都被占则交给系统分配（PORT=0）
  local p="$WANT_PORT"
  if port_in_use "$p"; then
    local h; h="$(health "$p")"
    if is_ours "$h"; then say "↻ 端口 $p 上已有本项目的服务，先停掉它"; stop_server; port_in_use "$p" || { printf '%s' "$p"; return 0; } fi
    for i in 1 2 3 4 5; do
      p=$((WANT_PORT + i))
      port_in_use "$p" || { printf '%s' "$p"; return 0; }
    done
    printf '0'   # 让 Bun 自己分配，随后从 NET_PORT_FILE 读回真实端口
  else
    printf '%s' "$p"
  fi
}

# ---------- 步骤 ----------
do_build() {
  say "▶ 构建前端产物"
  "$BUN_BIN" build.mjs >/dev/null
  local size; size="$(wc -c < dist/index.html | tr -d ' ')"
  [ -f dist/index.html ] || die "dist/index.html 未生成"
  [ -f dist/admin.html ] || die "dist/admin.html 未生成（后台运维台打不开）"
  say "  ✓ dist/index.html  $((size / 1024)) KB · dist/admin.html $(( $(wc -c < dist/admin.html | tr -d ' ') / 1024 )) KB"
}

do_smoke() {
  say "▶ 回归门禁（Node 侧 7 个用例）"
  local fails=0
  for t in race-unit items-unit net-race rooms-reconnect reconnect-core smoothness admin-api; do
    if out="$("$BUN_BIN" "test/$t.mjs" 2>&1)"; then
      printf '  ✓ %-18s %s\n' "$t" "$(printf '%s' "$out" | tr -d '\000' | grep -E '^结果' | tail -1)"
    else
      fails=$((fails + 1))
      printf '  ✗ %-18s\n%s\n' "$t" "$(printf '%s' "$out" | tr -d '\000' | grep -E '^(FAIL|结果)' | head -6)"
    fi
  done
  # 道具模式与竞速模式协议不同，net-race 要各自跑一遍
  if out="$(ITEM=1 "$BUN_BIN" test/net-race.mjs 2>&1)" && printf '%s' "$out" | grep -q '道具模式'; then
    printf '  ✓ %-18s %s\n' "net-race(道具)" "$(printf '%s' "$out" | tr -d '\000' | grep -E '^结果' | tail -1)"
  else
    fails=$((fails + 1))
    say "  ✗ net-race(道具) 失败，或 ITEM=1 没生效（跑出的是竞速用例）"
  fi
  [ "$fails" -eq 0 ] || die "回归未通过（$fails 个用例失败），已阻止启动"
  say "  ✓ 全绿"
}

do_start() {
  local port; port="$(pick_port)"
  say "▶ 启动服务器（端口 $port）"
  : > "$LOGF"
  PORT="$port" NET_PORT_FILE="$PORTF" "$BUN_BIN" server/index.js >>"$LOGF" 2>&1 &
  local pid=$!
  printf '%s' "$pid" > "$PIDF"

  # 服务器把真实监听端口写回 NET_PORT_FILE（PORT=0 时必需）
  local real="" tries=0
  while [ "$tries" -lt 60 ]; do
    tries=$((tries + 1))
    if [ -s "$PORTF" ]; then real="$(tr -d ' \t\r\n' < "$PORTF")"; [ -n "$real" ] && break; fi
    sleep 0.1
  done
  [ -n "$real" ] || { tail -5 "$LOGF" >&2; die "服务器没有写出监听端口，见 $LOGF"; }

  # 健康门禁：必须是本项目这个构建
  local h="" n=0
  while [ "$n" -lt 40 ]; do
    n=$((n + 1)); h="$(health "$real")"; is_ours "$h" && break; sleep 0.1
  done
  is_ours "$h" || { tail -8 "$LOGF" >&2; die "健康检查失败：端口 $real 上没有 $BUILD_ID"; }

  printf '%s' "$real" > "$TMP/deploy.running.port"
  local lan; lan="$(lan_ips)"
  say "  ✓ 就绪 (pid $pid · $BUILD_ID)"
  say ""
  say "  本机游玩   http://127.0.0.1:$real/"
  for ip in $lan; do say "  局域网     http://$ip:$real/"; done
  say ""
  say "  把上面的地址发给朋友，同一局域网内打开即可；进「在线对战」→ 创建房间，或从房间列表点加入。"
  local key; key="$(admin_key || true)"
  if [ -n "$key" ]; then
    say "  后台运维台 http://127.0.0.1:$real/admin?key=$key  （看房间/车手实况，可强制开赛、补电脑、请离、关房）"
  else
    say "  ! 后台口令没读到，见 $LOGF 或 ./deploy.sh admin"
  fi
  say "  服务器只在这台机器上跑：关掉脚本进程或 ./deploy.sh stop 即结束所有对局。"
  say "  日志 $(show_path "$LOGF") · 状态 ./deploy.sh status"
}

show_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1" 2>/dev/null || printf '%s' "$1"; else printf '%s' "$1"; fi; }

lan_ips() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) ipconfig 2>/dev/null | grep -a "IPv4" | awk '{print $NF}' ;;
    Darwin) ipconfig getifaddr en0 2>/dev/null || true ;;
    *) hostname -I 2>/dev/null || true ;;
  esac
}

# ---------- 后台运维台口令：env 优先，否则读服务器首次启动写下的文件 ----------
admin_key() {
  if [ -n "${ADMIN_TOKEN:-}" ]; then printf '%s' "$ADMIN_TOKEN"; return 0; fi
  local f="${ADMIN_TOKEN_FILE:-.data/admin-token}" n=0
  while [ "$n" -lt 30 ]; do
    n=$((n + 1))
    [ -s "$f" ] && { tr -d ' \t\r\n' < "$f"; return 0; }
    sleep 0.1
  done
  return 1
}

do_admin() {
  local port; port="$(running_port)"; [ -n "$port" ] || port="$WANT_PORT"
  local key; key="$(admin_key || true)"
  [ -n "$key" ] || die "读不到后台口令（启动日志里也有），或先设 ADMIN_TOKEN"
  say "后台运维台（只有本机与同网段能打开，别把地址发到公网）"
  say "  本机     http://127.0.0.1:$port/admin?key=$key"
  for ip in $(lan_ips); do say "  局域网   http://$ip:$port/admin?key=$key"; done
  say "  口令文件 ${ADMIN_TOKEN_FILE:-.data/admin-token} · 换口令：ADMIN_TOKEN=xxx ./deploy.sh restart"
}

running_port() { [ -f "$TMP/deploy.running.port" ] && cat "$TMP/deploy.running.port" || true; }

stop_server() {
  local port; port="$(running_port)"
  [ -n "$port" ] || port="$WANT_PORT"
  if [ -f "$PIDF" ]; then
    local pid; pid="$(cat "$PIDF")"
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
  fi
  # 端口上还有人应答就按端口反查真实进程（msys 的 pid 未必能被 Windows 认）
  local n=0
  while [ "$n" -lt 20 ] && port_in_use "$port"; do
    n=$((n + 1))
    case "$(uname -s)" in
      MINGW*|MSYS*|CYGWIN*)
        local winpid
        winpid="$(netstat -ano 2>/dev/null | grep -a ":$port .*LISTENING" | awk '{print $NF}' | head -1 || true)"
        [ -n "$winpid" ] && taskkill "//PID" "$winpid" "//F" >/dev/null 2>&1 || true
        ;;
      *)
        if command -v fuser >/dev/null 2>&1; then fuser -k "${port}/tcp" >/dev/null 2>&1 || true; fi
        ;;
    esac
    sleep 0.15
  done
  rm -f "$PIDF" "$PORTF" "$TMP/deploy.running.port"
  if port_in_use "$port"; then die "端口 $port 仍有服务在应答，请手动确认"; fi
  say "  ✓ 已停止（所有房间随之销毁）"
}

do_status() {
  local port; port="$(running_port)"
  if [ -z "$port" ]; then say "未在运行（./deploy.sh 启动）"; return 0; fi
  local h; h="$(health "$port")"
  if [ -z "$h" ]; then say "端口 $port 无应答，可能已被外部结束（./deploy.sh stop 清理记录）"; return 0; fi
  say "运行中 · 端口 $port"
  say "  healthz  $h"
  say "  房间     $(curl -fsS --max-time 2 "http://127.0.0.1:$port/rooms" 2>/dev/null || echo '（读不到）')"
}

RUN=false
for a in "$@"; do case "$a" in --smoke) SMOKE=true ;; esac; done

case "${1:-start}" in
  start) [ "${SMOKE:-false}" = true ] && do_smoke; do_build; do_start ;;
  stop) stop_server ;;
  restart) stop_server || true; [ "${SMOKE:-false}" = true ] && do_smoke; do_build; do_start ;;
  status) do_status ;;
  admin) do_admin ;;
  smoke) do_smoke ;;
  build) do_build ;;
  log) RUN=true; tail -f "$LOGF" ;;
  *) die "未知命令：$1（可用 start/stop/restart/status/admin/smoke/build/log）" ;;
esac
