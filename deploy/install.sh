#!/usr/bin/env bash
# Установщик GrigDesk на машину разработчика (host-native, per-machine).
# Ставит зависимости, собирает web, регистрирует и запускает systemd user-сервис.
# Идемпотентно: повторный прогон обновляет.
#
# Выбор человека: автозапуск при включении машины и ярлык GrigDesk на рабочем столе.
# Спрашивается в терминале; без терминала или флагами --autostart/--no-autostart и
# --shortcut/--no-shortcut. Оба решения потом меняются в «Настройки → Сервер».
set -euo pipefail

GRIGDESK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"   # в PATH сервиса: nvm-каталог node виден только так
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="grigdesk-server.service"

# Вопросы — до долгих шагов: после минут сборки их никто не ждёт. Ответы применяются в конце.
source "$GRIGDESK_DIR/deploy/lib/install-choices.sh"
grigdesk_install_parse_args "$@"
if [[ "$INSTALL_UNIT_ONLY" != 1 ]]; then
  grigdesk_install_choice INSTALL_AUTOSTART "Запускать GrigDesk при включении машины?" 1
  grigdesk_install_choice INSTALL_SHORTCUT "Создать ярлык GrigDesk на рабочем столе?" 0
fi

# Сообщения после установки должны показывать тот же порт, что прочитает сервер.
# .env разбирает Node: его содержимое не исполняется shell'ом.
source "$GRIGDESK_DIR/deploy/lib/runtime-env.sh"
grigdesk_require_migrated "$GRIGDESK_DIR"
DATA_HOME=$(grigdesk_data_home) || exit 1
ENV_FILE=$(grigdesk_env_file) || exit 1
HOME_ENV=
ENV_FILE_ENV=
if [[ -n "${GRIGDESK_HOME:-}" && "$DATA_HOME" != "${HOME%/}/.grigdesk" ]]; then
  HOME_ENV="Environment=GRIGDESK_HOME=$DATA_HOME"
fi
if [[ -n "${GRIGDESK_ENV_FILE:-}" ]]; then
  ENV_FILE_ENV="Environment=GRIGDESK_ENV_FILE=$GRIGDESK_ENV_FILE"
fi

# Путь файла настроек попадает в юнит и в sed: тот же алфавит, что у GRIGDESK_HOME.
# Пробел разорвал бы Environment=, «%» systemd раскрыл бы как спецификатор, «#» сломал бы sed.
grigdesk_check_env_file_path() {
  local LC_ALL=C

  [[ -z "${GRIGDESK_ENV_FILE:-}" || "$GRIGDESK_ENV_FILE" =~ ^/[A-Za-z0-9._+@,=:/-]+$ ]]
}

if ! grigdesk_check_env_file_path; then
  echo "GRIGDESK_ENV_FILE должен быть абсолютным путём из латинских букв, цифр и символов . _ + - / @ , = :" >&2
  exit 1
fi

# Запрещённые ключи в .env проверяются до юнита и до шага речи: EnvironmentFile применил бы
# GRIGDESK_HOME или GRIGDESK_ENV_FILE из файла раньше, чем сервер успел бы отказать.
grigdesk_load_runtime_env "$GRIGDESK_DIR" || exit $?

# Обновляет только описание службы. Смена запуска и установка зависимостей — отдельные шаги.
# Один шаблон используется обычной установкой и --unit-only после переноса данных.
install_unit() {
  mkdir -p "$UNIT_DIR"
  sed -e "s#__NODE__#$NODE_BIN#g" -e "s#__NODE_DIR__#$NODE_DIR#g" \
    -e "s#__GRIGDESK_DIR__#$GRIGDESK_DIR#g" -e "s#__ENV_FILE__#$ENV_FILE#g" \
    -e "s#__HOME_ENV__#$HOME_ENV#g" -e "s#__ENV_FILE_ENV__#$ENV_FILE_ENV#g" \
    "$GRIGDESK_DIR/deploy/$UNIT" > "$UNIT_DIR/$UNIT"
}

if [[ "$INSTALL_UNIT_ONLY" == 1 ]]; then
  install_unit
  systemctl --user daemon-reload
  exit 0
fi

# Команда b24 — собранный файл серверной поставки. Отказ сборки (код 1) не прерывает установку:
# прежняя ссылка остаётся, повторить шаг можно одной командой из предупреждения. Код 2 — сборка
# прошла, но чужой файл в PATH не тронут; об этом helper уже предупредил сам.
echo "→ CLI b24 в PATH…"
source "$GRIGDESK_DIR/deploy/lib/b24-cli.sh"
b24_status=0
grigdesk_install_b24_cli "$GRIGDESK_DIR" "$HOME/.local/bin" || b24_status=$?
if (( b24_status == 1 )); then
  printf '  ⚠ b24 не собран; повтор: bash %q %q %q\n' \
    "$GRIGDESK_DIR/deploy/lib/b24-cli.sh" "$GRIGDESK_DIR" "$HOME/.local/bin" >&2
fi
case ":$PATH:" in *":$HOME/.local/bin:"*) : ;; *) echo "  ⚠ добавь ~/.local/bin в PATH" ;; esac

( umask 077; mkdir -p "$DATA_HOME"; chmod 700 "$DATA_HOME" )
source "$GRIGDESK_DIR/deploy/lib/media-runtime.sh"
grigdesk_install_media "$GRIGDESK_DIR" ${INSTALL_PASSTHRU[@]+"${INSTALL_PASSTHRU[@]}"}
grigdesk_load_runtime_env "$GRIGDESK_DIR"
PORT="$GRIGDESK_EFFECTIVE_PORT"

echo "→ GrigDesk: $GRIGDESK_DIR"
echo "→ node:   $NODE_BIN ($(node -v))"

echo "→ Зависимости сервера…"
( cd "$GRIGDESK_DIR/server" && npm install --no-audit --no-fund )
# DeepSeek — один из исполнителей: без компилятора или сети установка GrigDesk продолжается.
( cd "$GRIGDESK_DIR/server" && npm run deepseek:prepare ) || \
  echo "⚠ DeepSeek не подготовлен; повтор после установки: bin/grigdesk-ctl deps" >&2

echo "→ Зависимости web + сборка…"
( cd "$GRIGDESK_DIR/web" && npm install --no-audit --no-fund && npm run build )

echo "→ systemd user-юнит…"
install_unit

echo "→ Команда grigdesk-ctl в PATH…"
source "$GRIGDESK_DIR/deploy/lib/cli-link.sh"
grigdesk_link_cli "$GRIGDESK_DIR" "$HOME/.local/bin" || true

# Порт уже держит GrigDesk (сервер приложения или ручной запуск): юнит рядом с ним ушёл бы
# в вечный перезапуск, выполняя стартовые хуки на каждом круге. Признак GrigDesk — ответ
# /api/auth/state с булевыми configured и authenticated за 2 с; чужой HTTP и тишина не в счёт.
grigdesk_answers_on_port() {
  local answer

  answer="$(node -e '
    fetch(process.argv[1], { redirect: "error", signal: AbortSignal.timeout(2000) })
      .then((response) => (response.status === 200 ? response.json() : null))
      .then((state) => {
        const flags = [state?.configured, state?.authenticated];
        process.stdout.write(flags.every((flag) => typeof flag === "boolean") ? "grigdesk" : "");
      })
      .catch(() => {});
  ' -- "http://127.0.0.1:$1/api/auth/state" 2>/dev/null || true)"

  [ "$answer" = grigdesk ]
}

systemctl --user daemon-reload

GRIGDESK_ALREADY_RUNNING=0
if grigdesk_answers_on_port "$PORT"; then
  GRIGDESK_ALREADY_RUNNING=1
  echo "→ GrigDesk уже работает на порту $PORT — юнит не запускаю"
fi

# Автозапуск — это enable юнита плюс linger: без него пользовательский systemd поднимается
# только при входе в сессию, а GrigDesk и Telegram нужны сразу после включения.
# Сервер поднимается, если порт ещё не держит GrigDesk; выбор потом переключается в «Настройки → Сервер».
if [ "$INSTALL_AUTOSTART" = 1 ]; then
  echo "→ Автозапуск при включении машины…"
  if [ "$GRIGDESK_ALREADY_RUNNING" = 1 ]; then
    systemctl --user enable "$UNIT"
  else
    systemctl --user enable --now "$UNIT"
  fi
  loginctl enable-linger || echo "  ⚠ linger не включился: до входа в систему GrigDesk стартовать не будет"
else
  echo "→ Без автозапуска: юнит остаётся, поднимать будут ярлык или systemctl --user start $UNIT"
  systemctl --user disable "$UNIT" >/dev/null 2>&1 || true
  if [ "$GRIGDESK_ALREADY_RUNNING" = 0 ]; then
    systemctl --user start "$UNIT"
  fi
fi

if [ "$INSTALL_SHORTCUT" = 1 ]; then
  echo "→ Ярлык на рабочем столе…"
  bash "$GRIGDESK_DIR/deploy/shortcut.sh" install || echo "  ⚠ ярлык не создан; позже — кнопка в «Настройки → Сервер»"
fi

echo "✓ Готово. Статус:"
systemctl --user --no-pager status "$UNIT" | head -n 6 || true
echo "  Логи:  journalctl --user -u $UNIT -f"
echo "  URL:   http://localhost:$PORT"
if [ "$INSTALL_AUTOSTART" = 1 ]; then
  echo "  Старт: при включении машины (переключается в «Настройки → Сервер»)"
else
  echo "  Старт: вручную — ярлык GrigDesk, grigdesk-ctl open или systemctl --user start $UNIT"
fi
echo
echo "  Приложение: установи проверенную сборку командой grigdesk-ctl desktop install"
echo "  Открыть: grigdesk-ctl open или ярлык GrigDesk"
echo "  Вход: автоматически по локальному ключу этого компьютера."
echo
echo "  Сервер: только на этой машине, http://localhost:$PORT"
