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
source "$COCKPIT_DIR/deploy/lib/install-choices.sh"
cockpit_install_parse_args "$@"
if [[ "$INSTALL_UNIT_ONLY" != 1 ]]; then
  cockpit_install_choice INSTALL_AUTOSTART "Запускать кокпит при включении машины?" 1
  cockpit_install_choice INSTALL_SHORTCUT "Создать ярлык «Кокпит» на рабочем столе?" 0
fi

# Сообщения после установки должны показывать тот же порт, что прочитает сервер.
# .env разбирает Node: его содержимое не исполняется shell'ом.
source "$COCKPIT_DIR/deploy/lib/runtime-env.sh"
cockpit_require_migrated "$COCKPIT_DIR"
DATA_HOME=$(cockpit_data_home) || exit 1
ENV_FILE=$(cockpit_env_file) || exit 1
HOME_ENV=
ENV_FILE_ENV=
if [[ -n "${COCKPIT_HOME:-}" && "$DATA_HOME" != "${HOME%/}/.cockpit" ]]; then
  HOME_ENV="Environment=COCKPIT_HOME=$DATA_HOME"
fi
if [[ -n "${COCKPIT_ENV_FILE:-}" ]]; then
  ENV_FILE_ENV="Environment=COCKPIT_ENV_FILE=$COCKPIT_ENV_FILE"
fi

# Путь файла настроек попадает в юнит и в sed: тот же алфавит, что у COCKPIT_HOME.
# Пробел разорвал бы Environment=, «%» systemd раскрыл бы как спецификатор, «#» сломал бы sed.
cockpit_check_env_file_path() {
  local LC_ALL=C

  [[ -z "${COCKPIT_ENV_FILE:-}" || "$COCKPIT_ENV_FILE" =~ ^/[A-Za-z0-9._+@,=:/-]+$ ]]
}

if ! cockpit_check_env_file_path; then
  echo "COCKPIT_ENV_FILE должен быть абсолютным путём из латинских букв, цифр и символов . _ + - / @ , = :" >&2
  exit 1
fi

# Запрещённые ключи в .env проверяются до юнита и до шага речи: EnvironmentFile применил бы
# COCKPIT_HOME или COCKPIT_ENV_FILE из файла раньше, чем сервер успел бы отказать.
cockpit_load_runtime_env "$COCKPIT_DIR" || exit 1

# Обновляет только описание службы. Смена запуска и установка зависимостей — отдельные шаги.
# Один шаблон используется обычной установкой и --unit-only после переноса данных.
install_unit() {
  mkdir -p "$UNIT_DIR"
  sed -e "s#__NODE__#$NODE_BIN#g" -e "s#__NODE_DIR__#$NODE_DIR#g" \
    -e "s#__COCKPIT_DIR__#$COCKPIT_DIR#g" -e "s#__ENV_FILE__#$ENV_FILE#g" \
    -e "s#__HOME_ENV__#$HOME_ENV#g" -e "s#__ENV_FILE_ENV__#$ENV_FILE_ENV#g" \
    "$COCKPIT_DIR/deploy/$UNIT" > "$UNIT_DIR/$UNIT"
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
source "$COCKPIT_DIR/deploy/lib/b24-cli.sh"
b24_status=0
cockpit_install_b24_cli "$COCKPIT_DIR" "$HOME/.local/bin" || b24_status=$?
if (( b24_status == 1 )); then
  printf '  ⚠ b24 не собран; повтор: bash %q %q %q\n' \
    "$COCKPIT_DIR/deploy/lib/b24-cli.sh" "$COCKPIT_DIR" "$HOME/.local/bin" >&2
fi
case ":$PATH:" in *":$HOME/.local/bin:"*) : ;; *) echo "  ⚠ добавь ~/.local/bin в PATH" ;; esac

( umask 077; mkdir -p "$DATA_HOME"; chmod 700 "$DATA_HOME" )
source "$COCKPIT_DIR/deploy/lib/media-runtime.sh"
cockpit_install_media "$COCKPIT_DIR" ${INSTALL_PASSTHRU[@]+"${INSTALL_PASSTHRU[@]}"}
cockpit_load_runtime_env "$COCKPIT_DIR"
PORT="$COCKPIT_EFFECTIVE_PORT"

echo "→ Кокпит: $COCKPIT_DIR"
echo "→ node:   $NODE_BIN ($(node -v))"

echo "→ Зависимости сервера…"
( cd "$COCKPIT_DIR/server" && npm install --no-audit --no-fund )
# DeepSeek — один из исполнителей: без компилятора или сети установка Cockpit продолжается.
( cd "$COCKPIT_DIR/server" && npm run deepseek:prepare ) || \
  echo "⚠ DeepSeek не подготовлен; повтор после установки: bin/cockpit deps" >&2

echo "→ Зависимости web + сборка…"
( cd "$COCKPIT_DIR/web" && npm install --no-audit --no-fund && npm run build )

echo "→ systemd user-юнит…"
install_unit

echo "→ Команда cockpit в PATH…"
source "$COCKPIT_DIR/deploy/lib/cli-link.sh"
cockpit_link_cli "$COCKPIT_DIR" "$HOME/.local/bin" || true

# Порт уже держит Кокпит (сервер приложения или ручной запуск): юнит рядом с ним ушёл бы
# в вечный перезапуск, выполняя стартовые хуки на каждом круге. Признак Кокпита — ответ
# /api/auth/state с булевыми configured и authenticated за 2 с; чужой HTTP и тишина не в счёт.
cockpit_answers_on_port() {
  local answer

  answer="$(node -e '
    fetch(process.argv[1], { redirect: "error", signal: AbortSignal.timeout(2000) })
      .then((response) => (response.status === 200 ? response.json() : null))
      .then((state) => {
        const flags = [state?.configured, state?.authenticated];
        process.stdout.write(flags.every((flag) => typeof flag === "boolean") ? "cockpit" : "");
      })
      .catch(() => {});
  ' -- "http://127.0.0.1:$1/api/auth/state" 2>/dev/null || true)"

  [ "$answer" = cockpit ]
}

systemctl --user daemon-reload

COCKPIT_ALREADY_RUNNING=0
if cockpit_answers_on_port "$PORT"; then
  COCKPIT_ALREADY_RUNNING=1
  echo "→ Кокпит уже работает на порту $PORT — юнит не запускаю"
fi

# Автозапуск — это enable юнита плюс linger: без него пользовательский systemd поднимается
# только при входе в сессию, а кокпит и Telegram нужны сразу после включения.
# Сервер поднимается, если порт ещё не держит Кокпит; выбор потом переключается в «Настройки → Сервер».
if [ "$INSTALL_AUTOSTART" = 1 ]; then
  echo "→ Автозапуск при включении машины…"
  if [ "$COCKPIT_ALREADY_RUNNING" = 1 ]; then
    systemctl --user enable "$UNIT"
  else
    systemctl --user enable --now "$UNIT"
  fi
  loginctl enable-linger || echo "  ⚠ linger не включился: до входа в систему кокпит стартовать не будет"
else
  echo "→ Без автозапуска: юнит остаётся, поднимать будут ярлык или systemctl --user start $UNIT"
  systemctl --user disable "$UNIT" >/dev/null 2>&1 || true
  if [ "$COCKPIT_ALREADY_RUNNING" = 0 ]; then
    systemctl --user start "$UNIT"
  fi
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
  echo "  Старт: вручную — ярлык «Кокпит», cockpit open или systemctl --user start $UNIT"
fi
echo
echo "  Приложение: установи проверенную сборку командой cockpit desktop install"
echo "  Открыть: cockpit open или ярлык «Кокпит»"
echo "  Вход: автоматически по локальному ключу этого компьютера."
echo
echo "  Сервер: только на этой машине, http://localhost:$PORT"
