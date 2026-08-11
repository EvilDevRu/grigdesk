#!/usr/bin/env bash
# Ворота VPN: по умолчанию возвращают 0, только если трафик РЕАЛЬНО идёт через TUN.
# COCKPIT_REQUIRE_VPN=0 явно отключает защиту, а COCKPIT_VPN_IFACE задаёт интерфейс для
# схем, которые нельзя распознать по `/sys/class/net/<iface>/tun_flags` (например WireGuard).
# В ExecStartPre ненулевой код не даёт systemd запустить защищаемый процесс и оставляет
# его ждать готового маршрута.
#
# ПОЧЕМУ НЕ ХВАТАЕТ ПРОВЕРКИ «ИНТЕРФЕЙС ЕСТЬ». VPN-клиент может создать устройство и
# только потом расставить правила маршрутизации. Между этими моментами интерфейс уже «up»,
# а трафик ещё идёт мимо — стартовать в это окно означает ровно ту утечку, от которой
# ворота и ставятся. Поэтому решает маршрут, а не наличие устройства.
#
# Policy routing может зависеть от владельца сокета. Проверка обязана выполняться от того
# же пользователя, что и защищаемый процесс, иначе ответ будет про чужой трафик. Для
# systemd --user это выполняется само.
set -uo pipefail

REQUIRED="${COCKPIT_REQUIRE_VPN:-1}"

fail() { echo "VPN-ворота: $1 — запуск запрещён" >&2; exit 1; }

case "$REQUIRED" in
  0|false|no) exit 0 ;;
  1|true|yes) ;;
  *) fail "COCKPIT_REQUIRE_VPN должен быть 0 или 1" ;;
esac

IFACE="${COCKPIT_VPN_IFACE:-}"
PROBE="${COCKPIT_VPN_PROBE:-1.1.1.1}"

SYS_CLASS_NET=/sys/class/net
IP_BIN=ip
if [[ "${FACTORY_TESTING:-0}" == 1 ]]; then
  SYS_CLASS_NET="${COCKPIT_VPN_SYS_CLASS_NET:-$SYS_CLASS_NET}"
  IP_BIN="${COCKPIT_IP_BIN:-$IP_BIN}"
fi

route=$("$IP_BIN" route get "$PROBE" 2>/dev/null | head -1)
[[ -n "$route" ]] || fail "нет маршрута до $PROBE"

route_iface=''
read -r -a route_parts <<<"$route"
for ((i = 0; i + 1 < ${#route_parts[@]}; i++)); do
  if [[ "${route_parts[$i]}" == dev ]]; then
    route_iface="${route_parts[$((i + 1))]}"
    break
  fi
done
[[ -n "$route_iface" ]] || fail "маршрут до $PROBE не называет интерфейс ($route)"
[[ "$route_iface" =~ ^[A-Za-z0-9_.:+-]{1,15}$ ]] || fail "маршрут вернул недопустимое имя интерфейса"

if [[ -z "$IFACE" ]]; then
  IFACE="$route_iface"
  [[ -e "$SYS_CLASS_NET/$IFACE/tun_flags" ]] ||
    fail "маршрут до $PROBE идёт не через автоматически распознанный TUN ($route)"
fi
[[ "$IFACE" =~ ^[A-Za-z0-9_.:+-]{1,15}$ ]] || fail "недопустимое имя интерфейса"
[[ -e "$SYS_CLASS_NET/$IFACE" ]] || fail "нет интерфейса $IFACE (VPN не поднят)"

# tun-устройства часто рапортуют operstate=unknown — это норма, а не сбой.
oper=$(cat "$SYS_CLASS_NET/$IFACE/operstate" 2>/dev/null || echo "?")
[[ "$oper" == "up" || "$oper" == "unknown" ]] || fail "$IFACE в состоянии '$oper'"

[[ "$route_iface" == "$IFACE" ]] || fail "трафик до $PROBE идёт мимо туннеля ($route)"

echo "VPN-ворота: $IFACE поднят, трафик до $PROBE идёт через него — старт разрешён"
