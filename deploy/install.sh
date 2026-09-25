#!/usr/bin/env bash
# Установщик кокпита на машину разработчика (host-native, per-machine).
# Ставит зависимости, собирает web, регистрирует и запускает systemd user-сервис.
# Идемпотентно: повторный прогон обновляет.
#
# Выбор человека: автозапуск при включении машины и ярлык «Кокпит» на рабочем столе.
# Спрашивается в терминале; без терминала или флагами --autostart/--no-autostart и
# --shortcut/--no-shortcut. Оба решения потом меняются в «Настройки → Сервер».
set -euo pipefail

COCKPIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"   # в PATH сервиса: nvm-каталог node виден только так
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="cockpit-server.service"

# Вопросы — до долгих шагов: после минут сборки их никто не ждёт. Ответы применяются в конце.
source "$COCKPIT_DIR/bin/lib/install-choices.sh"
cockpit_install_parse_args "$@"
cockpit_install_choice INSTALL_AUTOSTART "Запускать кокпит при включении машины?" 1
cockpit_install_choice INSTALL_SHORTCUT "Создать ярлык «Кокпит» на рабочем столе?" 0

# Сообщения после установки должны показывать те же порты, что прочитает сервер.
# .env разбирает Node: его содержимое не исполняется shell'ом.
source "$COCKPIT_DIR/bin/lib/runtime-env.sh"
source "$COCKPIT_DIR/bin/lib/media-runtime.sh"
cockpit_install_media "$COCKPIT_DIR" ${INSTALL_PASSTHRU[@]+"${INSTALL_PASSTHRU[@]}"}
# Версию проверяем до любой записи: юнит, который не сможет стартовать, ставить нельзя.
cockpit_load_runtime_env "$COCKPIT_DIR"
PORT="$COCKPIT_EFFECTIVE_PORT"
TLS_PORT="$COCKPIT_EFFECTIVE_TLS_PORT"

echo "→ Кокпит: $COCKPIT_DIR"
echo "→ node:   $NODE_BIN ($(node -v))"

echo "→ Зависимости сервера…"
( cd "$COCKPIT_DIR/server" && npm install --no-audit --no-fund )

echo "→ Зависимости web + сборка…"
( cd "$COCKPIT_DIR/web" && npm install --no-audit --no-fund && npm run build )

echo "→ systemd user-юнит…"
mkdir -p "$UNIT_DIR"
sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__NODE_DIR__|$NODE_DIR|g" -e "s|__COCKPIT_DIR__|$COCKPIT_DIR|g" \
  "$COCKPIT_DIR/deploy/$UNIT" > "$UNIT_DIR/$UNIT"

echo "→ CLI b24 в PATH…"
mkdir -p "$HOME/.local/bin"
ln -sf "$COCKPIT_DIR/bin/b24" "$HOME/.local/bin/b24"
case ":$PATH:" in *":$HOME/.local/bin:"*) : ;; *) echo "  ⚠ добавь ~/.local/bin в PATH" ;; esac

systemctl --user daemon-reload
# Автозапуск — это enable юнита плюс linger: без него пользовательский systemd поднимается
# только при входе в сессию, а кокпит нужен планшету и Telegram сразу после включения.
# Сервер поднимается в любом случае; сам выбор потом переключается в «Настройки → Сервер».
if [ "$INSTALL_AUTOSTART" = 1 ]; then
  echo "→ Автозапуск при включении машины…"
  systemctl --user enable --now "$UNIT"
  loginctl enable-linger || echo "  ⚠ linger не включился: до входа в систему кокпит стартовать не будет"
else
  echo "→ Без автозапуска: юнит остаётся, поднимать будут ярлык или systemctl --user start $UNIT"
  systemctl --user disable "$UNIT" >/dev/null 2>&1 || true
  systemctl --user start "$UNIT"
fi

if [ "$INSTALL_SHORTCUT" = 1 ]; then
  echo "→ Ярлык на рабочем столе…"
  bash "$COCKPIT_DIR/deploy/shortcut.sh" install || echo "  ⚠ ярлык не создан; позже — кнопка в «Настройки → Сервер»"
fi

echo "✓ Готово. Статус:"
systemctl --user --no-pager status "$UNIT" | head -n 6 || true
echo "  Логи:  journalctl --user -u $UNIT -f"
echo "  URL:   http://localhost:$PORT"
if [ "$INSTALL_AUTOSTART" = 1 ]; then
  echo "  Старт: при включении машины (переключается в «Настройки → Сервер»)"
else
  echo "  Старт: вручную — ярлык «Кокпит», bin/launch или systemctl --user start $UNIT"
fi
echo
# Вход в кокпит: пароль НЕ генерируем и в файлы не пишем — его задаёт человек при первом
# открытии (экран первичной настройки). Пока пароль не задан, весь /api закрыт, а `setup`
# доступен ровно один раз: как только пароль есть, повторно переустановить его нельзя.
if [ -f "$COCKPIT_DIR/server/.state/auth-account.json" ]; then
  echo "  Вход:  пароль уже задан (Настройки → Доступ, чтобы сменить)"
else
  echo "  Вход:  открой http://localhost:$PORT и задай пароль — до этого API закрыт."
  echo "         ВАЖНО: сделай это ДО того, как откроешь кокпит из сети: экран первичной"
  echo "         настройки доступен любому, кто зайдёт первым."
fi
echo
echo "  Доступ из сети: нужен HTTPS, иначе пароль уйдёт открытым текстом."
echo "                  «Настройки → Доступ»: включить режим «Из домашней сети», выпустить"
echo "                  сертификат, поставить корень на планшет по QR, перезапустить сервер"
echo "                  (второй порт — $TLS_PORT). Без включённого режима кокпит слушает только $PORT."
echo "                  Готовый сертификат подключается через COCKPIT_TLS_KEY/COCKPIT_TLS_CERT."
