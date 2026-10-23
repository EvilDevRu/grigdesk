# Единая команда GrigDesk

`grigdesk-ctl` открывает установленное окно. Окно с `runtime.json` установки само поднимает
сервер ([сервер под приложением](desktop-owned-server.md)), и команда больше ничего не
запрашивает. Без `runtime.json` (переходный режим до установки новой сборки) команда, как
прежде, затем запрашивает запуск `grigdesk-server.service`.
Команда требует Node ^22.19.0 либо >=24.0.0. `deploy/install.sh` ставит ссылку
`~/.local/bin/grigdesk-ctl`; прежняя ссылка заменяется, чужой обычный файл сохраняется с предупреждением.
Ссылки прежних имён команды (`grigdesk` и имя до переименования продукта) в том же каталоге
удаляются, только если ведут в `bin/` этой копии. Установленное окно команда ищет в
`<корень копии>/bin/grigdesk-app`.

## Команды

| Команда | Поведение |
| --- | --- |
| `grigdesk-ctl`, `grigdesk-ctl open [--force]` | Окно; без `runtime.json` — ещё запрос запуска службы |
| `grigdesk-ctl status [--json]` | Сервер, окно, локальный контейнер и связи |
| `grigdesk-ctl server start [--wait]` | `start --no-block`; работающий сервер сохраняется |
| `grigdesk-ctl server stop [--force]` | Остановка с ожиданием systemd |
| `grigdesk-ctl server restart [--wait] [--force]` | Перезапуск с ожиданием systemd |
| `grigdesk-ctl server status [--json]` | Только сервер |
| `grigdesk-ctl server logs [-n N] [-f]` | Журнал службы без pager |
| `grigdesk-ctl relay start \| stop \| restart` | Управление существующим контейнером Docker |
| `grigdesk-ctl relay status [--json]` | Только локальный посредник и связи сервера |
| `grigdesk-ctl relay logs [-n N] [-f]` | Журнал выбранного контейнера |
| `grigdesk-ctl device add <имя> [--address host:port] [--json]` | Строка и QR привязки полного приложения |
| `grigdesk-ctl device list [--json]` | Привязанные устройства и их scope |
| `grigdesk-ctl device revoke <id>` | Отзыв сертификата и разрыв соединений |
| `grigdesk-ctl desktop …`, `mobile …`, `release …` | Передача прежним скриптам |
| `grigdesk-ctl b24 …` | Собранный `bin/b24`, без него — исходник `b24/src/main.ts` ([команда b24](../b24/binary-cli.md)) |
| `grigdesk-ctl bundle` | Свежая переносимая папка и архив без установки ([контракт](portable-bundle.md)) |
| `grigdesk-ctl build [all\|server\|web\|window]` | Сборка и установка; без цели — сервер, веб, окно ([контракт](ctl-build.md)) |
| `grigdesk-ctl dev`, `deps`, `run` | Прежние команды разработки |
| `grigdesk-ctl --help`, `-h`, `help`; `--help` или `-h` в любой команде | Справка без внешних вызовов |
| `grigdesk-ctl --version` | Версия собственной копии из VERSION |

`--lines N` заменяет `-n N`, `--follow` заменяет `-f`; число строк — целое 1…10000,
по умолчанию 100. Форма `--lines=N` не принимается. `--json` допускается для status и device add/list.
Цвет включается только в TTY, при пустом `NO_COLOR` и `TERM`, отличном от `dumb`.

## Состояния

Готовность подтверждает общий `shared/runtime/grigDeskReadiness.ts`: GET `/api/auth/state`, status 200,
JSON-объект с boolean `configured` и `authenticated`. Redirect, чужой HTTP и зависание
готовностью не считаются. Закрытый порт отличается от занятого; владелец порта не завершается.

| Компонент | Состояния JSON и подписи |
| --- | --- |
| Сервер | ready — Работает; starting — Запускается; stopping — Останавливается; not_responding — Не отвечает; stopped — Остановлен; failed — Упал; conflict — Конфликт порта; not_installed — Не установлен; mismatch — Чужая служба; unknown — Неизвестно |
| Окно | open — Открыто; closed — Закрыто; not_installed — Не установлено; unknown — Неизвестно |
| Посредник | ready — Работает; starting — Запускается; unhealthy — Не проходит проверку; stopped — Остановлен; not_deployed — Не развёрнут; ambiguous — Несколько контейнеров; docker_unavailable — Docker недоступен |
| Связь | online — на связи; connecting — подключается; waiting_vpn — ждёт VPN; offline — нет связи; error — ошибка; unknown — неизвестно |

`managed: true` означает службу текущей копии; false — сервер вне службы (приложение GrigDesk
или ручной запуск), другую копию либо отсутствие службы; null — принадлежность не проверена.
Причина для готового сервера вне службы — «работает вне службы» (при остановленной службе —
«работает вне службы, служба остановлена»); `stop` и `restart` для него отвечают «Сервер
работает вне службы (приложение GrigDesk или ручной запуск); systemd им не управляет». `WorkingDirectory` установленной
службы должен равняться `<корень>/server`. При недоступном systemd готовый HTTP остаётся ready,
но имеет managed null и причину «служба не проверена»; остальные случаи дают unknown.
Активная служба с закрытым портом показывает starting, с зависшим HTTP — not_responding.
`start` в последнем случае предлагает `grigdesk-ctl server restart`. Во время остановки `stop` отвечает
«Сервер уже останавливается», а `start` и `restart` передаются systemd: он выполнит их после слива.

При activating CLI читает последние 50 строк журнала. Последняя строка `VPN-ворота: … —
запуск запрещён` даёт причину «ждёт VPN: …»; последующая успешная строка снимает отказ.
`--wait` опрашивает состояние раз в 500 мс, по умолчанию до 90 секунд. stop/restart сообщают,
что systemd ждёт завершения идущих ходов до 45 секунд.

Локальный посредник выбирается по метке service=relay и точному `config_files`, равному
`<корень>/relay/compose.yaml`. Проверочный compose-проект с двумя файлами не подходит.
`GRIGDESK_RELAY_PROJECT` выбирает по метке project вместо пути; несколько подходящих
контейнеров дают ambiguous. running + healthy либо отсутствие healthcheck — ready;
проверка starting или restarting — starting; unhealthy — unhealthy, остальное — stopped.
Отсутствующий Docker даёт not_deployed, отказ daemon — docker_unavailable.

Сервер, окно и контейнер читаются параллельно. Связи берутся из `/api/mobile/status` по
CLI-токену лишь после готового ответа сервера. Печатаются только имена и состояния.
Управляющие символы имён и причин заменяются на `?` и в тексте, и в JSON.

## JSON и коды

stdout содержит ровно один документ с конечным переводом строки:

```json
{
  "server": { "state": "ready", "managed": true, "url": "http://127.0.0.1:8140/", "reason": null },
  "window": { "state": "closed" },
  "relay": {
    "state": "ready", "container": "example-relay-1", "reason": null,
    "links": [{ "name": "Дом", "state": "online" }]
  }
}
```

У `server status --json` только ключ server, у `relay status --json` — relay.
links равен null при недоступном сервере, токене либо неразобранном ответе mobile/status.

Коды: 0 — выполнено или запрос принят, включая status с неизвестными состояниями;
1 — отказ действия; 2 — неверные аргументы, сообщение подсказывает `grigdesk-ctl --help` либо
список действий группы; 3 — срок `--wait` истёк. logs возвращает
код journalctl/docker, при сигнале — 128 + номер сигнала.

## Сторож и окружение

Процесс внутри сегмента cgroup `grigdesk-server.service` не может вызвать stop, restart
или открытие окна без `--force`: это оборвало бы ход агента либо открыло окно из него.
Сторож срабатывает до любых внешних команд и сетевых запросов. Ошибка чтения cgroup
считается отсутствием принадлежности службе.

Файл выбирается через `GRIGDESK_ENV_FILE`, иначе `<папка данных>/.env`.
`GRIGDESK_HOME` и `GRIGDESK_ENV_FILE` внутри него запрещены. До переноса CLI использует
[переходное чтение](data-home.md#команды-и-тесты).

`.env` разбирается `util.parseEnv`, shell-подстановки остаются текстом. Наличие ключа в env
важнее файла. Порт — `Number(GRIGDESK_PORT) || 8140`. `GRIGDESK_CLI_TOKEN_PATH` задаёт файл
токена, default — `<папка данных>/state/cli-token`. Окно получает исходное окружение CLI и
`GRIGDESK_WINDOW_KEY_PATH` из файла, если ключ не задан в env; прочие ключи файла не экспортируются.
`GRIGDESK_DESKTOP_DATA_DIR` выбирает только абсолютный каталог профиля окна.

Для тестов: `GRIGDESK_CLI_CGROUP_FILE` заменяет `/proc/self/cgroup`, `GRIGDESK_WAIT_SEC` меняет
срок ожидания. Обычной работе эти переменные не нужны.

Обычные команды открывания и управления не убивают владельца порта, не собирают и не
устанавливают приложение, не создают временный юнит, не выполняют `compose up` и не
запускают посредник автоматически. Явные прежние dev/build/deps/run сохраняют свою подготовку.
При отсутствии службы нужен `deploy/install.sh --no-autostart`; при отсутствии окна —
`grigdesk-ctl desktop install`. Ярлык показывает отказ уведомлением с причиной из stderr.

## Проверки

Команды device получают ключ через `shared/desktop/windowKeyPath.ts` и обменивают его на
`POST /api/auth/window-session?short=1`. Сессия живёт 600 секунд, cookie хранится только в
памяти команды. CLI-токен для выдачи привязки не используется. Без ключа команда сообщает,
что должна выполняться на машине с запущенным сервером; выключенный вход предлагает
задать `GRIGDESK_CLIENT_LISTEN`.

Терминальный QR рисуется полублоками с полем 4 модуля. Цвета чёрного на белом включаются
только в TTY без `NO_COLOR`; JSON не содержит терминальный QR. После строки печатается
«Действует 10 минут, один раз». Проверки: `tests/cli/device.test.mts`,
`tests/server/auth-window-session.test.js`; обычный обмен сохраняет прежние 400 дней.

`tests/cli/{readiness,entry,server,open,relay-status,cli-link}.test.mts` проверяют чистые
правила и CLI через [песочницу](../testing/cli-sandbox.md). Проверки ярлыка —
`tests/server/{launch-script,shortcut-script,docker-launch}.test.js`; заставки —
`tests/desktop/offline.test.js`. Включены общий typecheck, граф входов и сторож миграции.
Переходный режим `open` — `tests/cli/open.test.mts` (CO-4…8): с исправным `runtime.json`
ни systemctl, ни HTTP не вызываются.

В [переносимом комплекте](portable-bundle.md) `open` находит корневой `GrigDesk`,
не передаёт forced origin и всегда поручает запуск сервера окну, даже без runtime.json.
Библиотека ctl лежит в bin/lib; команды работают своим Node из payload без исходников.
