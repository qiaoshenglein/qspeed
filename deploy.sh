#!/usr/bin/env bash
# 飞车 3D · 在线对战一键部署（本机 / 局域网）
#
#   ./deploy.sh              构建并启动（默认），打印局域网分享地址
#   ./deploy.sh setup        第一次部署用：装依赖 + 问公网IP/UDP端口段（存进 .deploy.env）+ 启动
#   ./deploy.sh public-ip IP 只改公网 IP 并记住，然后 ./deploy.sh restart
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
#           RTC_PORT_RANGE=40000-40099  比赛数据的 UDP 端口段（公网部署要在安全组放行同样的 UDP 段）
#           RTC_PUBLIC_IP=1.2.3.4       服务器对外的公网地址（EIP 未绑到网卡、机器自己看不到公网 IP 时必须给）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
TMP="$ROOT/.tmp"
mkdir -p "$TMP"
PIDF="$TMP/deploy.pid"
PORTF="$TMP/deploy.port"
LOGF="$TMP/server.log"
BUILD_ID="qq-speed-net-v2"
ENVF="$ROOT/.deploy.env"

# 上次 setup 存下来的参数（真实环境变量优先，方便临时覆盖）
if [ -f "$ENVF" ]; then
  while IFS='=' read -r k v; do
    case "$k" in
      PORT) : "${PORT:=$v}" ;;
      BUN) : "${BUN:=$v}" ;;
      RTC_PORT_RANGE) : "${RTC_PORT_RANGE:=$v}" ;;
      RTC_PUBLIC_IP) : "${RTC_PUBLIC_IP:=$v}" ;;
    esac
  done < <(grep -av '^\s*#' "$ENVF" | grep -a '=' || true)
fi

WANT_PORT="${PORT:-8790}"
RTC_PORT_RANGE="${RTC_PORT_RANGE:-40000-40099}"
RTC_PUBLIC_IP="${RTC_PUBLIC_IP:-}"

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
# 缺依赖是"只同步代码、没跑 bun install"的典型症状，而它冒出来的样子是模块找不到，
# 很容易被当成端口或代码问题，所以在这里先按名字确认。
check_deps() {
  local miss=""
  [ -d node_modules/esbuild ] || miss="$miss esbuild"
  [ -d node_modules/werift ] || miss="$miss werift"
  [ -z "$miss" ] || die "缺少依赖：${miss# }。先运行 bun install（werift 是服务端的 WebRTC 传输层，esbuild 用来构建前端）"
}

do_build() {
  check_deps
  say "▶ 构建前端产物"
  "$BUN_BIN" build.mjs >/dev/null
  local size; size="$(wc -c < dist/index.html | tr -d ' ')"
  [ -f dist/index.html ] || die "dist/index.html 未生成"
  [ -f dist/admin.html ] || die "dist/admin.html 未生成（后台运维台打不开）"
  say "  ✓ dist/index.html  $((size / 1024)) KB · dist/admin.html $(( $(wc -c < dist/admin.html | tr -d ' ') / 1024 )) KB"
}

do_smoke() {
  local fails=0
  # 传输层先自检：DTLS/SCTP 起不来时，后面每一条用例都会以"连不上"的形式失败，看不出真原因
  if out="$("$BUN_BIN" test/rtc-loopback.mjs 2 2>&1 | tr -d '\000')" && printf '%s' "$out" | grep -q '握手：2/2'; then
    printf '  ✓ %-18s %s\n' "rtc 传输自检" "$(printf '%s' "$out" | grep -E '往返时延' | head -1)"
  else
    fails=$((fails + 1))
    say "  ✗ WebRTC 传输层自检没通过：比赛数据通道在这台机器上跑不起来，先解决它再看其余用例"
    printf '%s\n' "$out" | head -4
  fi
  say "▶ 回归门禁（Node 侧 7 个用例）"
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
    say "  ✗ net-race(道具) 没通过（或 ITEM=1 没生效，跑出的是竞速用例）"
    printf '%s\n' "$(printf '%s' "$out" | tr -d '\000' | grep -E '^(FAIL|SKIP|结果)' | head -6)"
  fi
  # 高延迟瞬移门禁：只跑 240/400ms 两档、每档 3 秒，控制在半分钟以内
  if out="$(GATE=1 ONLY=240,400 MEASURE_MS=3000 "$BUN_BIN" test/high-latency.mjs 2>&1 | tr -d '\000')"; then
    passed="$(printf '%s' "$out" | grep -cE '^PASS')"; skipped="$(printf '%s' "$out" | grep -cE '^SKIP')"
    if [ "$passed" -eq 0 ]; then
      # 一个"全部因负载跳过"的门禁等于没门禁：绿色会骗人，这里必须按失败处理
      fails=$((fails + 1))
      say "  ✗ 高延迟瞬移：两档都因机器负载跳过了，这次什么都没验到（跑完再在空闲机器上重跑一次）"
      printf '%s\n' "$out" | grep -E '^SKIP' | head -2
    else
      if [ "$skipped" -gt 0 ]; then
        say "  ✓ 高延迟瞬移 ${passed} 档无可感知瞬移（另有 ${skipped} 档因机器负载跳过，见日志）"
      else
        say "  ✓ 高延迟瞬移 ${passed} 档无可感知瞬移"
      fi
    fi
  else
    fails=$((fails + 1))
    printf '%s\n' "$out" | grep -E '^(FAIL|SKIP|结果)' | head -6
  fi
  [ "$fails" -eq 0 ] || die "回归未通过（$fails 个用例失败），已阻止启动"
  say "  ✓ 全绿"
}

do_start() {
  local port; port="$(pick_port)"
  say "▶ 启动服务器（端口 $port）"
  : > "$LOGF"
  PORT="$port" NET_PORT_FILE="$PORTF" RTC_PORT_RANGE="$RTC_PORT_RANGE" RTC_PUBLIC_IP="$RTC_PUBLIC_IP" \
    "$BUN_BIN" server/index.js >>"$LOGF" 2>&1 &
  local pid=$!
  printf '%s' "$pid" > "$PIDF"

  # 服务器把真实监听端口写回 NET_PORT_FILE（PORT=0 时必需）
  local real="" tries=0
  while [ "$tries" -lt 60 ]; do
    tries=$((tries + 1))
    if [ -s "$PORTF" ]; then real="$(tr -d ' \t\r\n' < "$PORTF")"; [ -n "$real" ] && break; fi
    sleep 0.1
  done
  [ -n "$real" ] || {
    tail -8 "$LOGF" >&2
    grep -qaE "Cannot find package|Module not found|resolve" "$LOGF" \
      && die "服务器起不来：日志里是模块解析失败，八成没跑 bun install" \
      || die "服务器没有写出监听端口，见 $LOGF"
  }

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
  say "  比赛数据走 UDP 数据通道（WebRTC），信令仍是 HTTP："
  say "    · UDP 端口段 $RTC_PORT_RANGE 必须在防火墙/云安全组放行（只放行 TCP 的话玩家连得上大厅、进不了比赛）"
  if [ -n "$RTC_PUBLIC_IP" ]; then say "    · 对外 advertised 地址 $RTC_PUBLIC_IP"
  else say "    · 未设 RTC_PUBLIC_IP：用本机网卡地址。机器自己看不到公网 IP（NAT 式公网）时，请设 RTC_PUBLIC_IP=<公网IP> 后重启"; fi
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

# ---------- setup：把公网 IP / UDP 端口段问一次，存进 .deploy.env ----------
# 非交互环境（CI、管道、nohup）不提问，直接用默认值或已存值，绝不卡住
ask() {
  local q="$1" d="$2" a=""
  if [ ! -t 0 ]; then printf '%s' "$d"; return 0; fi
  printf '%s [回车=%s]: ' "$q" "${d:-留空}" >&2
  read -r a || a=""
  printf '%s' "${a:-$d}"
}

save_env() {
  {
    printf '# deploy.sh setup 存的参数（不含后台口令，口令仍在 .data/admin-token）\n'
    printf 'PORT=%s\n' "${WANT_PORT:-8790}"
    printf 'RTC_PORT_RANGE=%s\n' "$RTC_PORT_RANGE"
    printf 'RTC_PUBLIC_IP=%s\n' "$RTC_PUBLIC_IP"
  } > "$ENVF"
  say "  已写入 $(show_path "$ENVF")，以后直接 ./deploy.sh 就不用再填"
}

# 云服务器上"网卡地址看不到公网 IP"是最常见的连不上原因；先探一下给用户当默认值
guess_public_ip() {
  command -v curl >/dev/null 2>&1 || return 0
  local u g
  for u in https://ifconfig.me/ip https://api.ipify.org; do
    g="$(curl -fsS --max-time 3 "$u" 2>/dev/null | tr -dc '0-9.')"
    case "$g" in *.*.*) printf '%s' "$g"; return 0 ;; esac
  done
}

do_setup() {
  say "▶ 一键部署设置（只做一次）"
  if [ ! -d node_modules/esbuild ] || [ ! -d node_modules/werift ]; then
    say "  缺依赖，安装中：bun install（werift 是服务端的 WebRTC 传输层，只装在服务端）"
    "$BUN_BIN" install >/dev/null 2>&1 || die "bun install 失败：这台机器能访问 npm 源吗？"
    say "  ✓ 依赖就位"
  else
    say "  ✓ 依赖已在"
  fi

  local ip="$RTC_PUBLIC_IP" guess=""
  if [ -z "$ip" ]; then
    guess="$(guess_public_ip || true)"
    [ -n "$guess" ] && say "  探测到这台机器对外的地址：$guess（云上一般就是公网 IP）"
    ip="$(ask "公网 IP —— 玩家从公网连进来要用它；纯局域网玩就留空" "$guess")"
  else
    say "  已存公网 IP：$ip（要改：./deploy.sh public-ip <IP>）"
  fi
  RTC_PUBLIC_IP="$ip"

  RTC_PORT_RANGE="$(ask "UDP 端口段 —— 云安全组要放行同样的 UDP 入方向" "$RTC_PORT_RANGE")"
  save_env

  if [ -n "$RTC_PUBLIC_IP" ]; then
    say "  还差一件事（脚本替不了你做）：在云控制台放行 UDP $RTC_PORT_RANGE 入方向到这台机器"
    say "  自检口诀：玩家能进大厅、进不了比赛 = UDP 没通；连大厅都打不开 = TCP 端口没通"
  else
    say "  没填公网 IP：将用本机网卡地址。局域网内可玩；若这台机器网卡看不到公网 IP，请 ./deploy.sh public-ip <公网IP> 后重启"
  fi
}

do_public_ip() {
  local ip="${1:-}"
  [ -n "$ip" ] || ip="$(ask "公网 IP" "${RTC_PUBLIC_IP:-}")"
  [ -n "$ip" ] || die "没给地址：./deploy.sh public-ip 43.163.68.6"
  RTC_PUBLIC_IP="$ip"
  save_env
  say "已记下 $ip · 重启生效：./deploy.sh restart"
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
  setup) do_setup; do_build; do_start ;;
  public-ip) do_public_ip "${2:-}" ;;
  stop) stop_server ;;
  restart) stop_server || true; [ "${SMOKE:-false}" = true ] && do_smoke; do_build; do_start ;;
  status) do_status ;;
  admin) do_admin ;;
  smoke) do_smoke ;;
  build) do_build ;;
  log) RUN=true; tail -f "$LOGF" ;;
  *) die "未知命令：$1（可用 start/stop/restart/status/admin/smoke/build/log）" ;;
esac
