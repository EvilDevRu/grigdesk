# Кокпит

Модульный пульт управления работой: доска задач Битрикс24, конвейер/фабрика агентов,
триаж задач, чат с LLM-агентами, распознавание видео в задачи, веб-терминал.

Модель: **один «мозг» (домашний ПК) + окна**. Сервер host-native, читает состояние фабрики
(`~/.factory/state`) и командует ей; планшет/рабочий комп — окна (браузер) через Tailscale.

## Структура

```
server/   Fastify (Node ESM, :8140) — API; модули: factory, b24, chat, analysis,
          agents, routes, providers, projects, code, plugins, auth, gateway, media,
          terminal, settings; исполнители LLM — server/src/lib/executors/
web/      Vite + Vue 3 (PWA) — окно; по умолчанию отдаётся самим сервером
engine/   project-agnostic движок фабрики и CLI
profiles/ локальные профили проектов: policy, graph, env и скрипты; каталог не коммитится
docs/     документация по подсистемам; движок — в docs/engine/
tests/    единый тестовый контур: docs/, engine/, server/, web/
bin/      скрипты: cockpit (запуск/сборка), restart (перезапуск без гонок), b24 (CLI к Б24)
deploy/   systemd user-юнит + install.sh
chats/    история чатов        (данные, самогитигнор)
agents/   шаблоны агентов      (данные, самогитигнор)
routes/   маршруты конвейера + промпты узлов схем (данные, самогитигнор)
```

Документация начинается с [docs/README.md](docs/README.md), тесты — с
[tests/README.md](tests/README.md). Полный офлайн-прогон: `bash tests/run-all.sh`.

## Системные требования

| Что | Версия | Зачем |
|---|---|---|
| Linux + systemd (user) | — | боевой режим — user-юнит (`deploy/install.sh`) |
| Node.js | **≥ 22** | `engines` в `server/package.json`; `.env` грузится нативным `--env-file` |
| npm | — | зависимости `server/` и `web/` |
| bash | — | `bin/*`, `deploy/install.sh`; профили фабрики сервер читает через `bash -c` |
| git | — | ветки и диффы worktree'ов задач |
| util-linux: `script` | — | PTY веб-терминала (`script -qfc`) — нативный `node-pty` не нужен |
| iproute2: `ss`, `ip` | — | занятость :8140 и ворота VPN |

Не обязательно, но без этого часть разделов пустая:

- **`claude` и/или `codex` CLI** — исполнители чатов и этапов фабрики. Недоступный CLI остаётся
  виден в реестре, но выбрать его для нового запуска нельзя; политика фабрики отдельно проверяется
  metadata-only preflight.
- **ffmpeg + ffprobe** и **venv с faster-whisper** (`COCKPIT_MEDIA_PYTHON`) — «Видео» и диктовка;
  чего не хватает, скажет предполётная проверка `lib/media/preflight.js`.

> **nvm.** У systemd свой PATH, nvm-шный node в нём не виден — `install.sh` подставляет в юнит
> абсолютный путь. Переключил версию через nvm — прогони установщик заново.

## Запуск

```bash
bin/cockpit deps       # первый раз: зависимости server + web
bin/cockpit            # собрать web и запустить сервер (:8140, один origin)
bin/cockpit dev        # разработка: vite (:5180, hot-reload) + сервер
bin/cockpit build      # только собрать web

bin/restart            # перезапуск сервера: гасит порт, ЖДЁТ освобождения, health-чек.
                       # Единственный правильный способ перезапуска — ручной kill+start
                       # между параллельными сессиями ловит EADDRINUSE.
```

> **`bin/restart` — только для ручной разработки.** Он поднимает свой setsid-процесс, а не
> systemd-юнит. Если юнит при этом включён, он уходит в вечный crashloop по EADDRINUSE
> (27.07.2026 намотал 8057 падений) и в окна свободного порта успевает его перехватывать.
> Перед ручной работой: `systemctl --user stop cockpit-server`. Подробности и диагностика —
> `docs/cockpit/gotchas.md`, раздел «Два владельца порта 8140».

Переменные окружения — `server/src/config.js` (грузятся и из корневого `.env`):
`COCKPIT_PORT`, `COCKPIT_MEDIA_PYTHON` (venv whisper), `COCKPIT_CHAT_TIMEOUT_MS`,
`COCKPIT_ANALYSIS_CONCURRENCY`, `COCKPIT_DISCOVER_WITH_CLI_TOKEN` и др.
По умолчанию сервер использует встроенный `engine/` и локальный корневой `profiles/`.
Каталог `/profiles/` целиком находится в `.gitignore`: в нём допустимы машинные пути,
локальные интеграции и скачанные runtime-файлы, но не общая кодовая база.
`FACTORY_HOME`, `FACTORY_PROFILES_DIR` и `COCKPIT_FACTORY_BIN` нужны только для
осознанной внешней раскладки.

## Установка (боевая, host-native)

```bash
deploy/install.sh      # зависимости, сборка web, systemd user-сервис, симлинк b24 в PATH
# → http://localhost:8140  (с планшета — через Tailscale http://<ip>:8140)
```

Боевой режим — **только systemd-юнит**. Порядок перехода с ручного запуска на юнит:

```bash
systemctl --user stop cockpit-server        # остановить crashloop, если он идёт
deploy/install.sh                            # поставит/обновит юнит и включит его
kill <pid-ручного-экземпляра>                # ss -ltnp | grep :8140 — кто держит порт
systemctl --user reset-failed cockpit-server # обнулить счётчик падений
systemctl --user status cockpit-server
```

**Кокпит не поднимется без VPN.** В юните стоят ворота `deploy/require-vpn.sh`: пока трафик
наружу не идёт через туннель (`ip route get 1.1.1.1` → `dev singbox_tun`), сервер не стартует
и висит в `activating (auto-restart)`, повторяя попытку раз в 5 секунд. Причина пишется словами
в `journalctl --user -u cockpit-server`. Подняли VPN — кокпит стартует сам, команд не нужно.
Так задумано: sing-box запускается руками, и после перезагрузки машины веб-интерфейса не будет,
пока не поднимешь туннель.

## Что внутри (кратко)

- **Доска** — «Рабочий стол» Б24 (показатели, таймеры, задачи) + триаж-оценки задач
  агентом (сложность/риск/размер) и запуск на конвейер фабрики.
- **Конвейер** — живой граф стадий по задачам, возвраты, прогресс, стенды.
- **Чаты** — мультисессии доступных CLI-исполнителей (сейчас Claude и Codex): вложения,
  диктовка (whisper),
  слэш-команды, всплывашка разрешений, живой счётчик токенов, недоставленные ответы
  переживают F5 и рестарты.
- **Агенты / Маршруты** — редактируемые базы стадий и маршрутов конвейера.
- **Видео** — запись встречи → транскрипт → черновики задач в Б24.
- **Терминал** — PTY в браузере (авторизация CLI, ручные операции).

Подробности архитектуры и грабли — `CLAUDE.md` + `docs/cockpit/` (читается агентами
и людьми). Секреты (креды/куки Б24, ключи) — в `server/.state/` (gitignore).
