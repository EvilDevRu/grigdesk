#!/usr/bin/env bash
#
# Bootstrap ШЛЮЗА кокпита на чистом VPS (Debian/Ubuntu).
#
# Что делает: ставит Caddy (публичный HTTPS), готовит непривилегированного пользователя для
# обратного SSH-туннеля с МАКСИМАЛЬНО урезанными правами, закрывает сам сервер (ssh, файрвол,
# fail2ban, автообновления безопасности) и включает всё в systemd.
#
# Чего НЕ делает: не создаёт DNS-записи (нет доступа к твоей зоне) и не трогает мозг —
# сторона мозга поднимается отдельно, скриптом `deploy/gateway/brain-setup.sh`.
#
# ИДЕМПОТЕНТЕН: скрипт описывает нужное состояние, а не «установку». Повторный запуск
# безопасен и работает как обновление — каждый шаг сперва проверяет, что уже сделано.
#
# Запуск (от root на VPS):
#   COCKPIT_DOMAIN=cockpit.example.com \
#   COCKPIT_TUNNEL_PUBKEY="ssh-ed25519 AAAA... cockpit-tunnel" \
#   ./bootstrap.sh
#
# Переменные:
#   COCKPIT_DOMAIN       обязательна — основной домен кокпита; стенды живут на *.<домен>
#   COCKPIT_TUNNEL_PUBKEY обязательна — публичный ключ мозга (приватный остаётся на мозге)
#   COCKPIT_ACME_EMAIL   почта для Let's Encrypt (уведомления об истечении)
#   COCKPIT_ACME_STAGING =1 — тестовый ACME без лимитов; первый прогон делать так
#   COCKPIT_SSH_PORT     порт sshd (по умолчанию 22; сменишь — не забудь про свой доступ)
set -euo pipefail

# ── Параметры ────────────────────────────────────────────────────────────────
DOMAIN="${COCKPIT_DOMAIN:-}"
TUNNEL_PUBKEY="${COCKPIT_TUNNEL_PUBKEY:-}"
ACME_EMAIL="${COCKPIT_ACME_EMAIL:-}"
ACME_STAGING="${COCKPIT_ACME_STAGING:-0}"
SSH_PORT="${COCKPIT_SSH_PORT:-22}"

# Порты обратного туннеля. Два, а не один: тяжёлый трафик стендов (дев-бандлы Vite, HMR)
# не должен придавливать интерактив (SSE, терминал, чат). Одно SSH-соединение мультиплексирует
# всё в один TCP-поток, поэтому изоляция достигается ИМЕННО отдельными соединениями.
PORT_APP=18140      # кокпит
PORT_SANDBOX=18141  # стенды

TUNNEL_USER=cockpit-tunnel
STATE_DIR=/etc/cockpit-gateway
STATE_FILE="$STATE_DIR/state"
SCRIPT_VERSION=1

log()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── Предварительные проверки ─────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || die "Запускать от root."
[ -n "$DOMAIN" ] || die "Не задан COCKPIT_DOMAIN."
[ -n "$TUNNEL_PUBKEY" ] || die "Не задан COCKPIT_TUNNEL_PUBKEY (публичный ключ мозга)."
grep -qiE 'ID(_LIKE)?=.*(debian|ubuntu)' /etc/os-release \
  || die "Скрипт рассчитан на Debian/Ubuntu."
# Ключ должен быть похож на публичный, а не на приватный: обидная, но реальная ошибка.
case "$TUNNEL_PUBKEY" in
  ssh-ed25519*|ssh-rsa*|ecdsa-sha2-*) : ;;
  *) die "COCKPIT_TUNNEL_PUBKEY не похож на публичный ключ (ожидается ssh-ed25519/ssh-rsa/ecdsa-…)." ;;
esac
case "$TUNNEL_PUBKEY" in
  *PRIVATE*) die "Это ПРИВАТНЫЙ ключ. Нужен публичный (.pub) — приватный остаётся на мозге." ;;
esac

mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
PREV_VERSION=0
[ -f "$STATE_FILE" ] && PREV_VERSION="$(sed -n 's/^version=//p' "$STATE_FILE" | head -1)"
[ -n "$PREV_VERSION" ] || PREV_VERSION=0
if [ "$PREV_VERSION" -gt 0 ]; then
  log "Шлюз уже настроен (версия $PREV_VERSION) — привожу к нужному состоянию."
fi

export DEBIAN_FRONTEND=noninteractive

# ── 1. Пакеты ────────────────────────────────────────────────────────────────
log "Обновляю индексы пакетов"
apt-get update -qq

need_pkgs=()
for p in curl ca-certificates gnupg ufw fail2ban unattended-upgrades; do
  dpkg -s "$p" >/dev/null 2>&1 || need_pkgs+=("$p")
done
if [ ${#need_pkgs[@]} -gt 0 ]; then
  log "Ставлю: ${need_pkgs[*]}"
  apt-get install -y -qq "${need_pkgs[@]}"
fi
ok "Базовые пакеты на месте"

# ── 2. Caddy из официального репозитория ─────────────────────────────────────
if ! command -v caddy >/dev/null 2>&1; then
  log "Ставлю Caddy"
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi
ok "Caddy: $(caddy version | head -1)"

# ── 3. Пользователь туннеля: без шелла, без прав, только проброс двух портов ──
if ! id "$TUNNEL_USER" >/dev/null 2>&1; then
  log "Создаю пользователя $TUNNEL_USER (без шелла)"
  useradd --system --create-home --shell /usr/sbin/nologin "$TUNNEL_USER"
fi

TUNNEL_HOME="$(getent passwd "$TUNNEL_USER" | cut -d: -f6)"
install -d -m 700 -o "$TUNNEL_USER" -g "$TUNNEL_USER" "$TUNNEL_HOME/.ssh"

# Ключ ограничен по максимуму: без шелла, без агента, без X11, без исходящих туннелей,
# и разрешено слушать РОВНО два порта на loopback. Даже если ключ утечёт, им нельзя
# ни зайти на сервер, ни пробросить что-то ещё.
AUTH_LINE="restrict,port-forwarding,permitlisten=\"127.0.0.1:$PORT_APP\",permitlisten=\"127.0.0.1:$PORT_SANDBOX\" $TUNNEL_PUBKEY"
AUTH_FILE="$TUNNEL_HOME/.ssh/authorized_keys"
if [ ! -f "$AUTH_FILE" ] || ! grep -qF "$TUNNEL_PUBKEY" "$AUTH_FILE"; then
  log "Прописываю ключ туннеля с ограничениями"
  printf '%s\n' "$AUTH_LINE" > "$AUTH_FILE"
else
  # Ключ тот же, но ограничения могли измениться между версиями скрипта — переписываем.
  printf '%s\n' "$AUTH_LINE" > "$AUTH_FILE"
fi
chown "$TUNNEL_USER:$TUNNEL_USER" "$AUTH_FILE"; chmod 600 "$AUTH_FILE"
ok "Ключ туннеля ограничен портами $PORT_APP и $PORT_SANDBOX"

# ── 4. Защита sshd ───────────────────────────────────────────────────────────
# ВАЖНО: пароли отключаем только если у root уже есть свой ключ — иначе запрёмся снаружи.
SSHD_DROPIN=/etc/ssh/sshd_config.d/00-cockpit.conf
ROOT_HAS_KEY=0
[ -s /root/.ssh/authorized_keys ] && ROOT_HAS_KEY=1

log "Настраиваю sshd"
{
  echo "# Управляется bootstrap.sh кокпита. Правки вносить здесь."
  echo "Port $SSH_PORT"
  echo "PermitRootLogin prohibit-password"
  echo "KbdInteractiveAuthentication no"
  echo "X11Forwarding no"
  echo "AllowAgentForwarding no"
  # Нужен для обратного туннеля; GatewayPorts no держит проброшенные порты на loopback,
  # то есть из интернета они не видны — снаружи есть только Caddy.
  echo "AllowTcpForwarding yes"
  echo "GatewayPorts no"
  # Быстро вычищаем мёртвые сеансы. Без этого «умерший» туннель продолжает держать
  # проброшенный порт, и переподключение падает с «remote port forwarding failed».
  echo "ClientAliveInterval 30"
  echo "ClientAliveCountMax 3"
  if [ "$ROOT_HAS_KEY" -eq 1 ]; then
    echo "PasswordAuthentication no"
  else
    echo "# PasswordAuthentication оставлен включённым: у root нет ключа в"
    echo "# /root/.ssh/authorized_keys, отключение заперло бы доступ к серверу."
    echo "PasswordAuthentication yes"
  fi
} > "$SSHD_DROPIN"
chmod 644 "$SSHD_DROPIN"

if sshd -t; then
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
  if [ "$ROOT_HAS_KEY" -eq 1 ]; then
    ok "sshd: вход по паролю отключён, root — только по ключу"
  else
    warn "sshd: вход по паролю ОСТАВЛЕН — у root нет ключа. Положи свой ключ в /root/.ssh/authorized_keys и запусти скрипт снова."
  fi
else
  rm -f "$SSHD_DROPIN"
  die "Конфиг sshd не прошёл проверку — откатил, ничего не менял."
fi

# ── 5. Файрвол ───────────────────────────────────────────────────────────────
# Порядок важен: сначала разрешаем SSH, только потом включаем ufw.
log "Настраиваю файрвол"
ufw --force default deny incoming >/dev/null
ufw --force default allow outgoing >/dev/null
ufw allow "$SSH_PORT/tcp" >/dev/null
ufw allow 80/tcp  >/dev/null   # нужен ACME (HTTP-01) и редирект на https
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null   # HTTP/3
if ! ufw status | grep -q '^Status: active'; then
  ufw --force enable >/dev/null
fi
ok "Открыты только $SSH_PORT, 80, 443. Порты туннеля наружу не видны (loopback)"

# ── 6. fail2ban + автообновления безопасности ────────────────────────────────
if [ ! -f /etc/fail2ban/jail.d/cockpit-sshd.conf ]; then
  cat > /etc/fail2ban/jail.d/cockpit-sshd.conf <<EOF
[sshd]
enabled = true
port    = $SSH_PORT
maxretry = 5
findtime = 10m
bantime  = 1h
EOF
fi
systemctl enable --now fail2ban >/dev/null 2>&1 || warn "fail2ban не запустился — проверь вручную"
ok "fail2ban следит за sshd"

cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
ok "Автообновления безопасности включены"

# ── 7. Caddy: конфиг ─────────────────────────────────────────────────────────
# Почему Caddy: сам получает и продлевает сертификаты, не буферизует (иначе SSE не работает),
# прозрачно пробрасывает вебсокеты (терминал), не режет размер тела (загрузка видео) и не
# рубит долгие ответы (ход агента до часа). На nginx каждый из этих пунктов — отдельная правка.
log "Пишу конфиг Caddy"
ACME_LINE=""
[ -n "$ACME_EMAIL" ] && ACME_LINE="email $ACME_EMAIL"
STAGING_LINE=""
if [ "$ACME_STAGING" = "1" ]; then
  STAGING_LINE="acme_ca https://acme-staging-v02.api.letsencrypt.org/directory"
  warn "ТЕСТОВЫЙ ACME: сертификат будет недоверенным. Для боевого запусти без COCKPIT_ACME_STAGING."
fi

cat > /etc/caddy/Caddyfile <<EOF
# Управляется bootstrap.sh кокпита. Правки — в скрипте, иначе затрёт при обновлении.
{
	$ACME_LINE
	$STAGING_LINE

	# Сертификаты «по требованию» — для динамических поддоменов стендов (p5191.<домен>).
	# Блок вида *.<домен> здесь НЕ годится: он требует wildcard-сертификата, а тот выдаётся
	# только через DNS-01, то есть через API DNS-провайдера (зона на Yandex — плагина может
	# не быть). On-demand берёт обычный HTTP-01 на каждое имя, никакого API не нужно.
	#
	# ask обязателен: без него любой, направив своё имя на наш адрес, заставит выпускать
	# сертификаты, пока не упрёмся в лимиты Let's Encrypt. Разрешение даёт сам кокпит.
	on_demand_tls {
		ask http://127.0.0.1:$PORT_APP/api/gateway/tls-allow
	}
}

# ── Кокпит ───────────────────────────────────────────────────────────────────
# Именованный блок: сертификат берётся сразу по HTTP-01, on-demand ему не нужен.
$DOMAIN {
	reverse_proxy 127.0.0.1:$PORT_APP {
		# Схему передаём приложению: от неё зависит флаг Secure у сессионной cookie.
		# Реальный адрес клиента Caddy дописывает в X-Forwarded-For сам — от него зависит
		# лимит попыток входа (иначе все попытки схлопнулись бы в адрес шлюза).
		header_up X-Forwarded-Proto {scheme}
	}
}

# ── Стенды: порт живёт в имени хоста (p5191.<домен>) ─────────────────────────
#
# Поддомен, а НЕ подпуть: дев-сервер Vite отдаёт ассеты от корня, под подпутём он ломается.
# Ловим всё остальное, но пускаем только имена нужного вида — диапазоны ограничены
# сознательно, иначе шлюз стал бы дверью к ЛЮБОМУ порту мозга, включая сам кокпит
# в обход входа, MySQL и ClickHouse.
https:// {
	tls {
		on_demand
	}

	@sandbox header_regexp Host ^p(51[7-9][0-9]|80[89][0-9])\.
	handle @sandbox {
		# Стенды своей авторизации не имеют вовсе, поэтому пускаем только с валидной сессией
		# кокпита: спрашиваем у него самого, прежде чем проксировать.
		#
		# Цель — /api/gateway/authz, а НЕ /api/auth/state: тот отвечает 200 и невошедшему,
		# а forward_auth смотрит только на код и пускал бы всех. authz стоит под гардом:
		# без ограниченной gateway-cookie 401, с ней 204. Полная cockpit_sid
		# остаётся host-only и на поддомен не отправляется.
		forward_auth 127.0.0.1:$PORT_APP {
			uri /api/gateway/authz
		}

		reverse_proxy 127.0.0.1:$PORT_SANDBOX {
			header_up X-Forwarded-Proto {scheme}
			# Forward-auth cookies нужны только Caddy. Код проверяемого PR не
			# должен получить ни старую полную сессию, ни gateway capability.
			# Остальные cookies самого приложения стенда сохраняем.
			header_up Cookie "(^|;[ ]*)cockpit_sid=[^;]*" ""
			header_up Cookie "(^|;[ ]*)cockpit_gateway=[^;]*" ""
		}
	}

	handle {
		respond "Неизвестный адрес" 404
	}
}
EOF

if caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  systemctl enable caddy >/dev/null 2>&1 || true
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  ok "Caddy запущен, конфиг валиден"
else
  caddy validate --config /etc/caddy/Caddyfile || true
  die "Конфиг Caddy не прошёл проверку — смотри вывод выше."
fi

# ── 8. Состояние ─────────────────────────────────────────────────────────────
cat > "$STATE_FILE" <<EOF
version=$SCRIPT_VERSION
domain=$DOMAIN
port_app=$PORT_APP
port_sandbox=$PORT_SANDBOX
tunnel_user=$TUNNEL_USER
ssh_port=$SSH_PORT
acme_staging=$ACME_STAGING
EOF
chmod 600 "$STATE_FILE"

echo
ok "Шлюз готов."
cat <<EOF

Дальше — на мозге:

  deploy/gateway/brain-setup.sh \\
    --gateway <адрес VPS> --domain $DOMAIN --ssh-port $SSH_PORT

Проверить DNS (обе записи должны указывать на этот сервер):
  $DOMAIN        A  <адрес VPS>
  *.$DOMAIN      A  <адрес VPS>

Полезное:
  systemctl status caddy          состояние прокси
  journalctl -u caddy -f          лог, в т.ч. выдача сертификатов
  ss -tlnp | grep 1814            появились ли порты туннеля (после запуска на мозге)
EOF
