#!/usr/bin/env bash
#
# Сторона МОЗГА для доступа к кокпиту через шлюз.
#
# Поднимает два обратных SSH-туннеля к VPS и локальный Caddy для стендов:
#
#   Туннель A (интерактив):  VPS:18140 → 127.0.0.1:8140   — кокпит НАПРЯМУЮ, без лишнего звена
#   Туннель B (объём):       VPS:18141 → 127.0.0.1:8141   — локальный Caddy, разбор по Host
#                                                            p5191.<домен> → 127.0.0.1:5191
#
# Почему два туннеля: одно SSH-соединение мультиплексирует всё в один TCP-поток, поэтому
# тяжёлые дев-бандлы стендов придавливали бы терминал и живые обновления. Изоляция достигается
# именно отдельными соединениями, а не числом портов.
#
# Почему туннель исходящий: мозг за NAT, входящие до него не доходят. Исходящее соединение
# умеет любая сеть — поэтому схема не зависит ни от провайдера, ни от смены тарифа, ни от CGNAT.
# И это ОБЫЧНОЕ TCP-соединение: оно не создаёт сетевых интерфейсов и не меняет маршруты,
# поэтому существующий VPN не задевает.
#
# ИДЕМПОТЕНТЕН: повторный запуск приводит к нужному состоянию и работает как обновление.
#
# Запуск:  sudo ./brain-setup.sh --gateway <адрес VPS> --domain cockpit.example.com [--ssh-port 22]
set -euo pipefail

GATEWAY=""
DOMAIN=""
SSH_PORT=22
COCKPIT_PORT=8140
BRAIN_CADDY_PORT=8141
PORT_APP=18140
PORT_SANDBOX=18141
TUNNEL_USER=cockpit-tunnel

log()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --gateway)  GATEWAY="$2"; shift 2 ;;
    --domain)   DOMAIN="$2"; shift 2 ;;
    --ssh-port) SSH_PORT="$2"; shift 2 ;;
    *) die "Неизвестный аргумент: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Запускать через sudo (нужны systemd-юниты)."
[ -n "$GATEWAY" ] || die "Не задан --gateway (адрес VPS)."
[ -n "$DOMAIN" ] || die "Не задан --domain."

# Владелец, от чьего имени живут туннели: у него в ~/.ssh лежит ключ.
OWNER="${SUDO_USER:-root}"
OWNER_HOME="$(getent passwd "$OWNER" | cut -d: -f6)"
[ -n "$OWNER_HOME" ] || die "Не могу определить домашний каталог пользователя $OWNER."
KEY="$OWNER_HOME/.ssh/cockpit-tunnel"

# ── 1. Ключ туннеля ──────────────────────────────────────────────────────────
if [ ! -f "$KEY" ]; then
  log "Создаю ключ туннеля $KEY"
  sudo -u "$OWNER" ssh-keygen -t ed25519 -N '' -C 'cockpit-tunnel' -f "$KEY" >/dev/null
fi
ok "Ключ туннеля на месте"

# ── 2. Локальный Caddy для стендов ───────────────────────────────────────────
if ! command -v caddy >/dev/null 2>&1; then
  log "Ставлю Caddy (нужен для разбора адресов стендов по Host)"
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi
ok "Caddy: $(caddy version | head -1)"

# Слушаем ТОЛЬКО loopback и только http: наружу этот порт не смотрит, TLS снимается на шлюзе.
# Диапазоны портов ограничены сознательно: иначе прокси стал бы дверью к любому локальному
# порту — включая сам кокпит в обход входа, MySQL и ClickHouse.
log "Пишу конфиг локального Caddy"
install -d -m 755 /etc/caddy
cat > /etc/caddy/cockpit-sandbox.caddyfile <<EOF
# Управляется brain-setup.sh кокпита. Разбирает адреса стендов вида p5191.$DOMAIN
# и проксирует на соответствующий локальный порт. Только loopback, только http.
{
	admin off
	auto_https off
}

http://127.0.0.1:$BRAIN_CADDY_PORT {
	# Порт достаём из имени хоста. Разрешены только диапазоны стендов и слотов:
	#   5170–5199 — фронты, 8080–8099 — API.
	@sandbox header_regexp port Host ^p(51[7-9][0-9]|80[89][0-9])\.
	handle @sandbox {
		reverse_proxy 127.0.0.1:{re.port.1}
	}

	# Всё, что не совпало с разрешёнными диапазонами, — молча отбиваем.
	handle {
		respond "Неизвестный стенд" 404
	}
}
EOF

if ! caddy validate --config /etc/caddy/cockpit-sandbox.caddyfile --adapter caddyfile >/dev/null 2>&1; then
  caddy validate --config /etc/caddy/cockpit-sandbox.caddyfile --adapter caddyfile || true
  die "Конфиг локального Caddy не прошёл проверку."
fi

cat > /etc/systemd/system/cockpit-sandbox-proxy.service <<EOF
[Unit]
Description=Кокпит: локальный прокси стендов (разбор по Host)
After=network.target

[Service]
ExecStart=/usr/bin/caddy run --config /etc/caddy/cockpit-sandbox.caddyfile --adapter caddyfile
Restart=always
RestartSec=3
User=$OWNER
# Прокси ходит только в loopback — ограничим ему всё остальное.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only

[Install]
WantedBy=multi-user.target
EOF
ok "Прокси стендов настроен (127.0.0.1:$BRAIN_CADDY_PORT)"

# ── 3. Юниты туннелей ────────────────────────────────────────────────────────
# ExitOnForwardFailure=yes — критично: без него ssh висит «подключённым» без проброса,
# и Caddy на шлюзе стучится в пустоту. ServerAlive* быстро обнаруживает мёртвое соединение,
# иначе на VPS остаётся залипший порт и переподключение падает с «forwarding failed».
write_tunnel_unit() {
  local name="$1" remote="$2" local_target="$3" desc="$4"
  cat > "/etc/systemd/system/$name.service" <<EOF
[Unit]
Description=Кокпит: обратный туннель — $desc
After=network-online.target $( [ "$name" = cockpit-tunnel-sandbox ] && echo cockpit-sandbox-proxy.service )
Wants=network-online.target

[Service]
User=$OWNER
ExecStart=/usr/bin/ssh -NT \\
  -o ExitOnForwardFailure=yes \\
  -o ServerAliveInterval=20 \\
  -o ServerAliveCountMax=3 \\
  -o StrictHostKeyChecking=accept-new \\
  -o BatchMode=yes \\
  -o Compression=no \\
  -i $KEY \\
  -p $SSH_PORT \\
  -R $remote:$local_target \\
  $TUNNEL_USER@$GATEWAY
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
}

write_tunnel_unit cockpit-tunnel-app     "127.0.0.1:$PORT_APP"     "127.0.0.1:$COCKPIT_PORT"     "кокпит (интерактив)"
write_tunnel_unit cockpit-tunnel-sandbox "127.0.0.1:$PORT_SANDBOX" "127.0.0.1:$BRAIN_CADDY_PORT" "стенды (объёмный трафик)"
ok "Юниты туннелей записаны"

systemctl daemon-reload
systemctl enable --now cockpit-sandbox-proxy >/dev/null 2>&1 || warn "прокси стендов не запустился — journalctl -u cockpit-sandbox-proxy"
systemctl enable --now cockpit-tunnel-app >/dev/null 2>&1 || warn "туннель кокпита не запустился"
systemctl enable --now cockpit-tunnel-sandbox >/dev/null 2>&1 || warn "туннель стендов не запустился"

echo
ok "Сторона мозга готова."
cat <<EOF

Ключ для шлюза (его надо передать в bootstrap.sh на VPS):

$(cat "$KEY.pub")

Не забудь включить в кокпите режим работы за шлюзом — в .env:

  COCKPIT_TRUST_PROXY=127.0.0.1
  COCKPIT_PUBLIC_DOMAIN=$DOMAIN

Первое: без него сессионная cookie уедет без флага Secure, а лимит попыток входа посчитает
всех клиентов одним адресом (и первый же перебор запрёт вход тебе).
Второе: без него шлюз не сможет выдать сертификат стендам, а cookie не уедет на их
поддомены — стенды окажутся недоступны.
После правки — bin/restart.

Проверка:
  systemctl status cockpit-tunnel-app cockpit-tunnel-sandbox
  journalctl -u cockpit-tunnel-app -f
  на VPS:  ss -tlnp | grep 1814     (должны появиться оба порта)
EOF
