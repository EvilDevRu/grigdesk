# Кокпит — CLAUDE.md

Пульт управления работой: доска задач Битрикс24, конвейер/фабрика (схемы и движение),
живые стенды, распознавание видео в задачи. «Комбайн» — новый виток над Python-дашбордом фабрики.

## Язык

Всё общение и комментарии в коде — **на русском**.

## Модель

**Один «мозг» (домашний ПК) + окна.** Всё тяжёлое (factory, стенды, Claude Code, **и сервер кокпита**)
живёт на мозге; планшет/рабочий комп — только окна (браузер) через Tailscale. Сервер **host-native**
(systemd, `deploy/install.sh`), НЕ в Docker: он командует host-уровнем (шеллит `factory bin`, читает
`/proc`, `~/.factory/state`, гоняет `docker`). Фронт по умолчанию отдаёт сам сервер (`@fastify/static`).

## Стек и структура

- **server/** — Fastify (Node ESM, порт **8140**). `src/{app,config}.js`, `plugins/` (sse, auth, static),
  `adapters/` (factory-state, b24, system, media), `lib/` (pipeline/stages/factory-graph парсеры, git,
  `b24/` — перенесённый `B24Client`, `media/` — перенесённый медиа-конвейер, claude-auth-store), `modules/`
  (factory, b24, system, media, chat, settings, health, terminal, agents, routes, providers).
- **web/** — Vite + Vue 3 (PWA). `views/` (Board, Pipeline, Agents, Chats, Routes, Diff, Video, Terminal,
  Settings, TaskModal, ChatPanel), `views/pipeline/FactoryGraph.vue` (SVG-граф), `views/chat/` (ChatList,
  ChatSession, ChatTabs, EffortSlider, StepList — лента хода агента, ChatQuestion — вопрос агента),
  `stores/` (Pinia: board, tasks, system, ui, pwa, chat, diff, providers, ui-context), `shared/`
  (api-client, layout, format, graph-geom, route-layout, diff — построчный LCS-дифф, ProviderIcon, ui/).
- **bin/b24** — CLI-обёртка к B24-API (в PATH через симлинк). **deploy/** — systemd-юнит + install.sh.
- **Базы в корне проекта** (самогитигнорятся, свой `.gitignore` внутри): `chats/` — история чатов
  (`YYYY-MM/<id>.json`), `agents/` — ШАБЛОНЫ агентов (`<id>.md`, frontmatter+заготовка промпта; один id =
  один шаблон, без коллизий по профилям), `routes/` — маршруты по проектам (`<профиль>/<id>.json`, цепочка+возвраты)
  + **промпты узлов сайдкарами** `<профиль>/<id>/<этап>.md`. Промпт — свойство места в схеме, не агента:
  при добавлении узла заготовка копируется из шаблона и дальше живёт в схеме (правится кликом по узлу).

## Ключевые эндпоинты

- Фабрика: `GET /api/tasks`, `/api/tasks/:id/graph` (схема+статусы+возвраты+nodeMeta),
  `/api/tasks/:id/diff` (git-диф worktree), `/api/factory/routes` (эталонные схемы),
  `POST /api/tasks/:id/sandbox/down`.
- B24: `GET /api/b24/dashboard` (полный «Рабочий стол»), `/api/b24/task/:id`, `/api/b24/users`;
  мутации `POST /api/b24/tasks` (создать), `/task/:id/{comment,timer/:action,complete,renew}`.
- Чат: `POST /api/chat` (свободный), `POST /api/tasks/:id/chat` (в worktree задачи),
  `GET/PUT /api/chat/store` (история — файлы `chats/`). Принимает `context` (UI-контекст страницы)
  и `attachments` (вложения). Вложения: `POST /api/chat/upload` (multipart → `chats/attachments/`),
  `GET /api/chat/attachment/:file` (превью). Диктовка: `POST /api/chat/transcribe` (аудио → whisper → текст).
  Разрешения на действия агента: SSE `chat-permission` → `POST /api/chat/permission/:pid` (всплывашка).
  **Вопрос агента** (AskUserQuestion): SSE `chat-question` → тот же `POST /api/chat/permission/:pid`
  с `{answers}` (ответ доезжает до агента через `deny.message` — см. chat-agents.md).
  **Лента хода** (инструменты/размышления, как в чате VS Code): SSE `chat-step`, шаги нормализует
  `lib/chat/stream-steps.js`, рисует `views/chat/StepList.vue`.
- Исполнители (ИИ): модульно в `server/src/lib/executors/` (один файл = один ИИ; файлы на `_` —
  вспомогательные, загрузчик их пропускает). Модели Claude берутся ИЗ БИНАРЯ установленного CLI
  (`_claude-catalog.js`) и мёржатся в редактируемый `server/.state/models.json` — никаких
  захардкоженных версий. `GET /api/providers` отдаёт всё для UI, `POST /api/providers/:id/update`
  обновляет CLI кнопкой из настроек, `POST /api/providers/check-updates` — проверка новых версий
  (она же идёт фоном раз в 6 часов → SSE `providers-update` → точка на иконке в топбаре).
  **Автообновления нет и не будет: кокпит только сообщает** (см. chat-agents.md).
- **Перезапуск сервера — только `bin/restart`** (гасит порт и ждёт освобождения; ручной kill+start
  между параллельными сессиями ловит EADDRINUSE).
- Базы: `GET/POST/PUT/DELETE /api/agents[/:id]` (+`/reseed`), `GET/POST/PUT/DELETE /api/routes[/:id]`,
  `GET /api/providers` (реестр LLM-исполнителей; его же рисует топбар).
- Вход: `GET /api/auth/state` (публичный), `POST /api/auth/{setup,login,logout,logout-all,password}`.
  Гард (`plugins/auth.js`) закрывает **весь** `/api` включая GET и WS-upgrade; публичны только
  `auth/{state,login,setup}` и `health`. UI — `views/LoginView.vue` + таб «Доступ» в настройках.
- Система: `GET /api/system` (CPU% + RAM вкл. swap). Медиа: `GET /api/media/doctor`,
  `POST /api/media/upload` (multipart → распознавание), `GET /api/media/ingest/:jobId` (статус/транскрипт).
- Настройки: `GET/POST /api/settings/b24` + `POST /api/settings/b24/test` (UI настроек — на табах).
  Терминал: `GET /api/terminal` (WebSocket, PTY). Реалтайм: `GET /api/events` (SSE).

## Ключевые решения (почему так)

- **Палитра — точная тёмная тема старого дашборда фабрики** (`#0b0d11/#151920/#5aa2ff/#3fb950/#e0a33a/#f0564c`).
  Кокпит закоммичен в dark.
- **Конвейер — порт `dashboard.py`**: `node_geom`/`edge_path` (12 типов кривых), `pipeline_statuses`
  (9 статусов узлов), `loop_facts` — портированы 1:1 в `lib/factory-graph.js` + `web/shared/graph-geom.js`.
- **B24 — session-cookie/CSRF-скрейпер** (официального REST в портале нет), перенесён из b24-mcp.
  **Все вызовы клиента сериализуются очередью `_run`** в адаптере (B24Client не потокобезопасен —
  конкурентные запросы рвут сессию, давали «Client Error»). Кокпит — единственный владелец сессии
  (свой cookie-файл в `.state`).
- **Мутации фабрики** — через `factory bin` (берёт flock) или прямой upsert `pipeline-set.sh`;
  **flock на `orch.lock` НЕ использовать** (демон держит его весь прогон — дедлок). Контракт запуска —
  машинный (чтение `ORCH_PID`+`/proc`), не парсинг stdout.
- **Медиа-конвейер** (whisper/ffmpeg) перенесён из b24-mcp; venv (492МБ) и модель (1.5ГБ)
  **переиспользуются** через `COCKPIT_MEDIA_PYTHON` (не дублируем).
- **Вход — один пользователь, пароль scrypt-хешем в `.state`, сессия в httpOnly-cookie.**
  Закрыт весь `/api` (чтение тоже: чаты, дифы, а через терминал — шелл). Экран входа показывает
  само приложение по 401, серверных редиректов НЕТ — они конфликтуют с service worker'ом PWA.
  `COCKPIT_TOKEN` убран: он утекал в публичный бандл через `VITE_COCKPIT_TOKEN`.
- **Никаких хардкодов проекта в коде**: профиль из реестра, обнаружение профилей сканом
  `factory/profiles/*.graph.json`, портал/креды из «Настроек» (`.state`), пути через env. Пустой кокпит
  ничего не знает о конкретном проекте.

## База знаний (как работает и тонкости — чтобы не перечитывать код)

@.claude/knowledge/architecture.md
@.claude/knowledge/factory-graph.md
@.claude/knowledge/chat-agents.md
@.claude/knowledge/gotchas.md

## Запуск

```bash
deploy/install.sh                 # боевая установка (зависимости, сборка web, systemd, симлинк b24)
cd server && npm start            # dev-сервер (:8140)
cd web && npm run dev             # dev-фронт (:5180, проксирует /api на :8140)
```
Секреты (креды/куки B24) — в `server/.state/` (gitignore).

## Гашение b24-mcp (в процессе)

Кокпит замещает b24-mcp. Переведены на `bin/b24`: `/commit-task`, `/pr-fixes`. Медиа-конвейер и
раздел «Видео» замещают `/video-task`. Осталось: репойнт `/b24` и `factory b24-timer.mjs`, удалить хук
`<профиль>-b24-factory.sh` + записи в `settings.json`/`~/.claude.json`, погасить контейнеры MCP.
