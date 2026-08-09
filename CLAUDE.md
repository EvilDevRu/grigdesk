# Кокпит — CLAUDE.md

Пульт управления работой: доска задач Битрикс24, конвейер/фабрика (схемы и движение),
живые стенды, распознавание видео в задачи. «Комбайн» — новый виток над Python-дашбордом фабрики.

Несмотря на имя файла, это общие инструкции проекта для Claude Code, Codex и других
исполнителей. Их адаптеры (`AGENTS.md` и встроенная загрузка Claude Code) должны приводить
к одному этому файлу и одной документации, а не поддерживать параллельные копии знаний.

## Язык

Всё общение и комментарии в коде — **на русском**.

## Работа с проектным контекстом

- `docs/` — источник истины об архитектуре, контрактах и уже внедрённых решениях;
  этот файл хранит только общие правила, карту и короткие инварианты.
- Отдельной проектной копии памяти исполнителя нет. Новый проверенный факт, который
  понадобится в следующих сессиях, записывается сразу в относящийся к нему документ,
  а локальная особенность профиля — в `profiles/<имя>/README.md` или документацию рядом
  с соответствующим кодом профиля.
- Общие `docs/`, `CLAUDE.md`, `AGENTS.md` и README не содержат названий реальных профилей,
  доменов, проектных стеков, диапазонов task ID и путей внутрь конкретного
  `profiles/<имя>/`. В примерах используются только `<profile>`, `<task-id>` и названия
  режимов; вся проектная конкретика остаётся в локальной документации профиля.
- Если команда, код или живое поведение расходятся с документацией, сначала проверь
  фактическое состояние, затем исправь канонический документ в том же заходе. Не оставляй
  известное расхождение до отдельной просьбы человека.
- Если для проверки нужен пароль или другой ручной шаг человека, задай короткий вопрос
  через доступную панель действий и жди ответа. Сначала доделай всё независимое; обходной
  стенд используй только если человек отказался выполнить шаг, и явно назови ограничение.

## Модель

**Один «мозг» (домашний ПК) + окна.** Всё тяжёлое (factory, стенды, Claude Code, **и сервер кокпита**)
живёт на мозге; планшет/рабочий комп — только окна (браузер): дома по локальной сети, снаружи
через шлюз на VPS (`deploy/gateway/`, см. [грабли](docs/cockpit/gotchas.md)). Сервер **host-native**
(systemd, `deploy/install.sh`), НЕ в Docker: он командует host-уровнем (шеллит `factory bin`, читает
`/proc`, `~/.factory/state`, гоняет `docker`). Фронт по умолчанию отдаёт сам сервер (`@fastify/static`).

## Стек и структура

- **server/** — Fastify (Node ESM, порт **8140**). `src/{app,config}.js`, `plugins/` (sse, auth, static),
  `adapters/` (factory-state, b24, system, media), `lib/` (pipeline/stages/factory-graph парсеры, git,
  `b24/` — перенесённый `B24Client`, `media/` — перенесённый медиа-конвейер, claude-auth-store,
  `inbox/` — общая очередь и решения, `telegram/`/`github/` — lifecycle, ingress и нативные
  account-scoped stores каналов), `modules/`
  (factory, b24, system, media, chat, settings, health, terminal, agents, routes, providers,
  analysis, auth, gateway, plugins, projects — реестр проектов с путями репозиториев,
  code — плагин «Код», inbox — плагин «Входящие», telegram/github — плагины каналов).
- **web/** — Vite + Vue 3 (PWA). `views/` (Board, Pipeline, Agents, Chats, Routes, Projects, Code, Diff,
  Tools, Video, Inbox, Telegram, GitHub, Terminal, Settings, Login, TaskModal, ChatPanel),
  `views/pipeline/FactoryGraph.vue` (SVG-граф), `views/chat/` (ChatList,
  ChatSession, ChatTabs, EffortSlider, StepList — лента хода агента, ChatQuestion — вопрос агента),
  `stores/` (Pinia: analysis, auth, board, chat, diff, dock, notify-watch, plugins, providers, pwa,
  system, tasks, inbox, ui, ui-context), `shared/`
  (api-client, layout — включая единственный `ToolHost`, tools registry/launcher, format,
  graph-geom, route-layout, diff — построчный LCS-дифф, monaco — общая обвязка Monaco
  для дифа и «Кода», ProviderIcon, ui/).
- **bin/b24** — CLI-обёртка к B24-API (в PATH через симлинк). **deploy/** — systemd-юнит + install.sh.
- **engine/** — канонический движок конвейера (демон задачи, этапы, агенты, стенды), встроенный
  в этот репозиторий. Свои правила — `engine/CLAUDE.md` и `docs/engine/ENGINE.md`.
  Профили проектов вынесены в локальный корень: `profiles/<имя>/` с `profile.sh`,
  `runners.env`, `graph.json`, `dashboard.env` и проектными скриптами. Весь `/profiles/`
  игнорируется Git и не является частью поставки репозитория. Сервер по умолчанию
  вызывает `engine/bin/factory`; внешний checkout возможен только через явные `FACTORY_HOME` /
  `COCKPIT_FACTORY_BIN`. Состояние задач — по-прежнему `~/.factory/state`.
- **Базы в корне проекта** (самогитигнорятся, свой `.gitignore` внутри): `chats/` — история чатов
  (`YYYY-MM/<id>.json`), `agents/` — ШАБЛОНЫ агентов (`<id>.md`, frontmatter+заготовка промпта; один id =
  один шаблон, без коллизий по профилям). **Маршрутов среди этих баз больше нет:** маршрут —
  опубликованный immutable-бандл в `~/.factory/routes/<профиль>/`, собирает его сам профиль
  (`profiles/<проект>/routes/publish.mjs`), кокпит только проверяет, публикует и откатывает.
  Промпт — свойство места в схеме, а не агента: шаблон агента даёт лишь заготовку, дальше текст
  живёт в бандле маршрута и правится в профиле.

## Ключевые эндпоинты

- Фабрика: `GET /api/tasks`, `/api/tasks/:id/graph` (схема+статусы+возвраты+nodeMeta),
  `/api/tasks/:id/diff` (git-диф worktree), `/api/factory/routes` (эталонные схемы),
  `POST /api/tasks/:id/runner/switch` (CAS-защищённое переключение активного runner-а),
  `POST /api/tasks/:id/sandbox/down`, `POST /api/tasks/:id/sandbox/retry` (снос остатков
  упавшей песочницы + resume — кнопка в плашке «стенд не поднялся»).
  Запуск: `GET /api/tasks/:id/launch-options` (чем заполнять модалку: профиль,
  маршруты ОПУБЛИКОВАННОГО каталога) → `POST /api/tasks/:id/launch`, `POST /api/tasks/:id/resume`
  (продолжить упавший прогон — только по кнопке человека и exact attempt).
  Единственный route-движок запускает только профиль с capability `route-v2` и опубликованным
  каталогом; иначе запрос fail-closed. Исторический реестр виден только для чтения и никогда
  не передаётся launcher-у. Постановка едет
  файлом-тикетом (ровно шесть полей, `lib/factory-ticket.js`) и валидируется В КОКПИТЕ:
  движок читает тикет только после подъёма песочницы, то есть через 20–25 минут.
  Ручная постановка задачи без трекера выполняется только по локальному runbook выбранного
  профиля; общая документация не задаёт для неё проектные команды или диапазоны ID.
- B24: граница интеграции, HTTP, CLI, протокол портала и правила мутаций описаны в
  `docs/cockpit/b24.md`.
- Чат: `POST /api/chat` (свободный), `POST /api/tasks/:id/chat` (в worktree задачи),
  `GET /api/chat/store` (история — файлы `chats/`), запись — **по одному чату**:
  `PUT /api/chat/store/chat` (`{chat, archived, origin}`), `DELETE /api/chat/store/chat/:id`,
  `PUT /api/chat/store/meta` (активный чат и дефолты). Записи разъезжаются по устройствам сами:
  сервер шлёт SSE `chat-store`/`chat-store-meta` (с `origin` пишущего окна, чтобы не ловить
  своё эхо), остальные окна тянут изменившийся чат через `GET /api/chat/store/chat/:id` —
  без этого разговор с планшета появлялся на компьютере только после F5.
  **Присланная копия не замещает серверную, а сливается с ней** (`lib/chat/merge-chat.js`):
  сервер не теряет сообщений, отставшее окно больше не стирает ответы, дошедшие до другого
  устройства — см. `docs/cockpit/chat-agents.md`.
  **Обрыв связи окна ≠ провал хода:** ход живёт в процессе сервера, порванный `POST /api/chat`
  его не останавливает, ответ придёт через `chats/pending`. Клиент такую ошибку в общую
  историю не пишет (локальная плашка «связь прервалась»), а метку обрыва, за которой уже
  стоит ответ агента, сервер снимает при сохранении.
  Полный `PUT /api/chat/store` остался
  только для миграции и восстановления снимка: одним телом история упиралась в лимит
  запроса — см. `docs/cockpit/gotchas.md`. Принимает `context` (UI-контекст страницы)
  и `attachments` (вложения). Вложения: `POST /api/chat/upload` (multipart → `chats/attachments/`),
  `GET /api/chat/attachment/:file` (превью). Диктовка: `POST /api/chat/transcribe` (аудио → whisper → текст).
  Разрешения на действия агента: SSE `chat-permission` → `POST /api/chat/permission/:pid` (всплывашка;
  отказ принимает `comment` — пояснение агенту, см. `docs/cockpit/chat-agents.md`).
  **Вопрос агента** (AskUserQuestion): SSE `chat-question` → тот же `POST /api/chat/permission/:pid`
  с `{answers}` (ответ доезжает до агента через `deny.message` — см. `docs/cockpit/chat-agents.md`).
  **Спрос висит до ответа** в пределах жизни процесса (технический потолок permission-call —
  сутки): `GET /api/chat/waiting` поднимает висящее после F5, лимит хода не тикает, пока
  ждём человека, а чаты «ждут тебя» помечены чипами в навигации
  и в списке чатов — см. `docs/cockpit/chat-agents.md`.
  **Лента хода** (инструменты/размышления, как в чате VS Code): SSE `chat-step`, шаги нормализует
  `lib/chat/stream-steps.js`, рисует `views/chat/StepList.vue`.
  **Сжатие контекста**: `POST /api/chat/compact` и `POST /api/tasks/:id/compact` (тот же `runChat`
  и та же очередь чата). Как именно сжимать — говорит исполнитель полем `compaction`: родная
  слэш-команда CLI либо выжимка текстом, которую кокпит подставит первым блоком следующего
  сообщения. Клик по кольцу контекста — сжатие, Alt+клик — сброс памяти агента.
  **Выше ~250k контекста ход дорожает в 20 раз** (кэш промпта перестаёт совпадать, переписка
  пишется в кэш заново): порог автокомпакта задаётся в «Настройках → Запуски», подробности и
  замеры — `docs/cockpit/chat-agents.md`.
- Исполнители (ИИ): модульно в `server/src/lib/executors/` (один файл = один ИИ; файлы на `_` —
  вспомогательные, загрузчик их пропускает). Модели Claude берутся ИЗ БИНАРЯ установленного CLI
  (`_claude-catalog.js`) и мёржатся в редактируемый `server/.state/models.json` — никаких
  захардкоженных версий. `GET /api/providers` отдаёт всё для UI (включая слэш-команды
  исполнителя — поле `commands?` контракта; меню «/» в чате, признак служебного хода
  `slashCommand` в `POST /api/chat` — см. `docs/cockpit/chat-agents.md`), `POST /api/providers/:id/update`
  обновляет CLI кнопкой из настроек, `POST /api/providers/check-updates` — проверка новых версий
  (она же идёт фоном раз в 6 часов → SSE `providers-update` → точка на иконке в топбаре).
  `GET /api/providers/:id/mcp` — MCP-серверы исполнителя для блока в его плашке настроек
  (метод контракта `mcpStatus?`); запрос ОТДЕЛЬНЫЙ и ленивый, потому что делает живой
  health-check и стоит секунд. Переподключать MCP между ходами нечего — процесс CLI
  поднимается на каждое сообщение (`docs/cockpit/gotchas.md`).
  Ollama (`ollama.js` + `_ollama-tools.js`) — локальный HTTP-исполнитель, но ход
  ПОЛНОЦЕННЫЙ: инструменты (чтение/поиск/правка/bash), режимы прав, эффорт и картинки
  даёт сам кокпит — демон приносит только модель. Что модель умеет, решают её
  `capabilities` из `/api/tags` (`tools`/`vision`/`thinking`), хардкода нет; эффорт
  бинарный (`think: true|false`). Песочница путей — realpath внутрь cwd и доверенных
  каталогов, у `bash` её нет по замыслу (держится подтверждением). Живой каталог моделей
  (`catalogLive`), адрес демона, `num_ctx` и время жизни модели в памяти — свои настройки
  исполнителя в prefs (`providerSettings.ollama`); `num_ctx` — ползунок, чей потолок
  вычисляется от памяти машины (свободная VRAM + 60% ОЗУ + занятое уже загруженной
  моделью − её веса, делённые на оценку KV-кэша из `model_info`), а `run()` клампит его
  по per-model оценке, но не ниже рабочего минимума 8192.
  Всплывашка в шапке показывает не лимиты (их нет), а память машины, загруженные модели
  и кнопку их выгрузки. Узлы схем конвейера Ollama НЕ исполняет: раннерам движка нужен
  агентский CLI, а `ollama run` — голый REPL (`docs/cockpit/chat-agents.md`).
  **Автообновления нет и не будет: кокпит только сообщает**
  (см. `docs/cockpit/chat-agents.md`).
  `GET /api/providers/usage` — полосы потребления лимитов во всплывашке шапки;
  `POST /api/providers/:id/credits` — доплата сверх лимитов (вкл/выкл и месячный потолок).
  **Доплата тратит реальные деньги: только по подтверждению человека, никогда сама**
  (`docs/cockpit/chat-agents.md`).
- **Перезапуск сервера — `bin/restart` или кнопка «Настройки → Сервер»** (`POST /api/system/restart`:
  под systemd — выход процесса, юнит с `Restart=always` поднимает; при ручном запуске — тот же
  `bin/restart` отвязанным процессом; режимы НЕ смешивать — см. историю 7553 падений в юните).
  **Агент, запущенный ИЗ чата кокпита, — дочерний процесс этого сервера:** перезапуск изнутри
  такого хода (скриптом ли, кнопочным ли API) убивает того, кто его ждёт, и ответ не доезжает
  никуда (даже в `chats/pending`). Правки сервера из чата — только с просьбой к человеку
  перезапустить.
- Базы: `GET/POST/PUT/DELETE /api/agents[/:id]` (+`/reseed`);
  проекты — `GET/POST /api/profiles`; маршруты — только опубликованные бандлы v2:
  `GET /api/routes/:profile/{current,revisions}`, `GET .../routes/:id/:hash[/graph]`,
  `PUT .../current` (откат, CAS), `POST .../publish` (`validate|publish` — собирает
  скрипт профиля `routes/publish.mjs`).
  `GET /api/providers` (реестр LLM-исполнителей; его же рисует топбар).
- Проекты: `GET /api/projects` (реестр: пути репозиториев — фабричным проектам их даёт профиль
  через `lib/analysis/profile.js`, кокпитным — prefs), `PUT /api/projects/:id` (пути кокпитного
  проекта; фабричному с путями в профиле — 409, источник правды один). Плагин «Код»:
  `GET /api/code/:project/{repos,ls,file,git}` — read-only просмотр любого дерева репозитория
  (основное + worktree из `git worktree list`), диф — тем же `lib/git.js`, что приёмка;
  UI показывает два уровня — проект и единую «Рабочую копию» (`repo + root` остаются внутренней
  парой API), а несохранённые изменения переключаются между деревом и плоским списком; гейт
  `pluginEnabled('code')` живой, как у видео. **Служебные каталоги закрыты для `ls` и `file`**
  (`isHiddenPath`): сегменты `.git`/`.state` в любом дереве плюс каталоги данных кокпита
  по фактическому пути из config (`chatsDir`, `telegramDir`, `githubDir`) — переписка и токены не
  для просмотра. Проверка по пути, а не по имени: одноимённый каталог в ЧУЖОМ репозитории
  — обычный чужой код и виден. `git` пути от клиента не принимает вовсе, поэтому
  гитигнорённое туда не попадает и закрывать его там нечего.
- Телеграм (плагин канала «Телеграм», раздел `/telegram`): подключение бота —
  `GET /api/telegram/status`, `POST /api/telegram/{connect,recheck,disconnect}`.
  **Кнопки «создать бота» нет и не будет: у Телеграма нет API создания ботов вовсе** —
  бот заводится только перепиской человека с @BotFather. Кокпит делает всё, что после:
  проверяет токен через `getMe` (порядок жёсткий — форма → сеть → запись, непроверенный
  токен не сохраняется), связывает подтверждённый `getMe.id` со случайным `accountRef`,
  кладёт активный token в `server/.state/telegram-account-creds.json` (0600, НЕ в prefs:
  те целиком уезжают в браузер) и наружу отдаёт только маску `…last4`. Runtime читает
  только account-aware stores и текущие owner-bound schemas: offline importer, flat-store
  fallback и startup migration отсутствуют. `recheck` нужен
  из-за режима приватности: его выключают в @BotFather ПОСЛЕ подключения, а отказ сети
  сохранённый токен не стирает. Два сорта отказа различаются кодом: `400 telegram_rejected`
  (Телеграм ответил и отказал) против `502 telegram_unreachable` (не доехали).
  **Опрос — long polling, не webhook** (`lib/telegram/account-poller.js`): `getUpdates` с
  `timeout=25` и `allowed_updates=[message,edited_message,message_reaction]`, `offset`
  переживает рестарт в `telegram/accounts/<accountRef>/state.json`, апдейты Телеграм
  держит сутки. Читатель у
  бота ровно ОДИН: второй получает `409 Conflict`, и это отдельное состояние
  (`poll.conflict` + текст словами), а не «бот не подключён» — подключённый токен и
  идущий опрос разные вещи, поэтому `GET /api/telegram/status` отдаёт `{bot, poll}`.
  Цикл заводится на старте сервера при наличии token, при `connect`/`recheck` и гаснет
  на `disconnect`; выключенный плагин означает «не ходить в сеть вовсе». Connect другого
  bot без явного disconnect запрещён. Switch отзывает новые leases старой generation,
  ждёт начатые операции и публикует новый current pointer только после durable metadata.
  Архив входящих —
  `telegram/` в корне проекта под самогитигнором (`config.telegramDir`): append-only
  `accounts/<accountRef>/archive/<chatId>/YYYY-MM.ndjson` (месяц по UTC), правка
  дописывается строкой (побеждает
  последняя версия `message_id`), вложения хранятся ссылкой `fileId`, а чтение идёт по
  смещению из индекса — горячая операция не имеет права дорожать от размера архива
  (грабли «фризы при наборе»). `GET /api/telegram/chats` — что бот уже слышал (имя, тип,
  форум, счётчик, время последнего): другого источника имён чатов у человека нет, и
  именно отсюда собирается привязка «чат/тема → проект».
  **Правила «чат или тема → проект» — ALLOWLIST, а не настройка удобства**
  (`lib/telegram/rules-store.js`, файл `telegram/accounts/<accountRef>/rules.json`;
  `GET/PUT /api/telegram/rules`,
  редактор — карточка «Разрешённые чаты» раздела). Развернётся только ссылка на чат,
  ПРИВЯЗАННЫЙ к проекту: иначе произвольная ссылка в описании задачи вытянула бы
  переписку любого чата, где бот случайно состоит. Пустой список значит «закрыто
  везде». Правило темы работает только для неё (соседние темы остаются закрытыми),
  правило с `threadId: null` покрывает и общий чат, и любую тему, а совпавшая тема
  сильнее общего правила независимо от порядка в файле. Адрес хранится обеими
  сторонами: у приватного чата в ссылке есть числовой id, у публичного — только имя
  (`username`), поэтому совпадает любая известная сторона. Свой файл, а не
  `pluginSettings`: та — плоская карта, список правил в неё не ложится. Проверка
  `kind`/`draft`/проекта — отказ с НОМЕРОМ правила, а не тихая подстановка дефолта.
  У правила есть отдельный выключенный по умолчанию `notifyTaskCreated`: после успешных
  B24 create И durable Inbox decision бот best-effort отвечает в exact исходный чат/тему
  номером и безопасной ссылкой задачи. Ручной и автоматический пути общие; Telegram failure
  не откатывает задачу и не ретраится автоматически, чтобы неопределённый timeout не дал дубль.
  **Хук на чтение — `POST /api/telegram/expand`** (`lib/telegram/resolve.js`): что стоит
  за ссылками `t.me` в тексте задачи. Ссылки разбирает `lib/telegram/links.js` — он же
  схлопывает дубли (одну ссылку любят вписать и в описание, и в комментарий рядом).
  Источника ровно два и в жёстком порядке: **архив** (единственный отдаёт ветку целиком,
  сеть не нужна) → **пересылка себе** `forwardMessage` в служебный чат с немедленным
  `deleteMessage` → отказ с причиной. Отказ ОТДАЁТСЯ, но без содержимого: ни текста,
  ни даже имени чужого чата — иначе allowlist защищал бы вид, а не данные. Причины
  названы поимённо (`not_allowed`, `older_than_bot`, `not_a_member`, `forward_restricted`,
  `comment_link`, `no_service_chat`, `not_connected`, `unreachable`, `unknown`):
  нераскрытая ссылка обязана объяснить себя, молчание читается как «в чате пусто».
  **Служебный чат — только личка, которую бот уже слышал** (`POST /api/telegram/service-chat`,
  карточка «Служебный чат» раздела). Произвольный id значил бы «пересылай рабочую
  переписку, куда скажу», групповой не годится даже свой — служебную копию там увидят
  все, и уведомление уходит до удаления. Автоподбор отпадает: боту мог написать
  посторонний. Лежит в `bot-settings.json` namespace конкретного бота, а не в prefs
  или общем credential: `recheck` и disconnect его сохраняют, возврат к тому же
  `accountRef` видит прежний адрес, а новый bot получает пустой namespace и ничего
  чужого не наследует.
  **Чужим модулям разворот отдаёт декоратор `fastify.telegramDiscussion(text, {project})`**,
  а не роут: объявляет его сам telegram (там гейт плагина, токен и правила), выключенный
  плагин даёт ПУСТОТУ вместо 404, а сбой разворота не роняет чужой ответ. Потребителей
  четыре: `GET /api/b24/task/:id` (доп. поле `telegram`, тело задачи не трогается),
  тикет конвейера (секция через `sections` `buildTicket`), **чат агента по задаче** и
  **триаж** (`lib/analysis/`) — там переписка идёт отдельным блоком промпта, потому что
  описание режется потолком `CAP_DESC` с конца; ради этого места разворот и затевался:
  рубрика велит ставить `confidence: low` на нераскрытых `t.me`-ссылках, то есть задача,
  вся суть которой в чате, приезжала оценщику заведомо мутной. Границей проекта во всех
  точках служит профиль ПРОГОНА задачи; у неоценённой задачи его нет — значит проект
  неизвестен и работает голый allowlist (профиль триажа сюда не годится: он выводится
  из активных задач, и граница безопасности зависела бы от того, что сейчас бежит).
  Анализатор создаётся в `app.js` РАНЬШЕ модуля telegram, поэтому ссылка на декоратор
  ленивая — ищется в момент вызова.
  В чате разворот делается ЗАНОВО, а закреплённая в тикете секция вырезается
  (`stripDiscussionSection`): тикет — снимок постановки, разговор идёт дальше, и две
  версии одного обсуждения агент разбирал бы за свой контекст. Секция стоит вне зоны
  действия потолка `TICKET_DESCRIPTION_MAX` — он режет описание с конца, а она в хвосте;
  свой лимит — `DISCUSSION_LIMITS`. Заголовок общий (`DISCUSSION_SECTION_TITLE`):
  вырезать можно только тем же текстом, которым вклеили.
  Пятый потребитель — **человек**: то же поле `telegram` рисует блок «Обсуждение в
  Telegram» в модалке задачи (`views/TaskModal.vue`), сразу под описанием — обсуждение
  это часть постановки, а не приложение к ней. Текст цитат приходит из ЧУЖОГО чата,
  поэтому только интерполяция: `v-html` там запрещён (описание задачи через него
  проходит, но его источник — портал). Нераскрытая ссылка показывается с причиной и
  без содержимого — как её отдал сервер; UI не придумывает за него ни имени чата,
  ни цитат. Вложения пока словами: `fileId` наружу не уходит вовсе, превью — фаза 4.
- **«Входящие» — отдельный общий плагин** (`lib/inbox/`, `modules/inbox/`, раздел
  `/inbox`), а Telegram и GitHub — независимые подключаемые каналы. Список, summary и
  состояние: `GET /api/inbox`, `/api/inbox/summary`, `/api/inbox/status`; решения:
  `POST /api/inbox/items/:ref/{task,dismiss,reset}`; участие канала:
  `POST /api/inbox/channels/:channel/{activate,deactivate}`. SSE `inbox-changed` означает
  «перечитай снимок», а минутный poll нужен для созревания Telegram-связки без нового
  сообщения. Старых `/api/telegram/inbox*`, `telegram-inbox` и `telegram/inbox.json`
  в runtime нет.
  Provider connection и Inbox activation — разные оси. Connect сам не активирует канал;
  activate создаёт server-side начало epoch, deactivate закрывает её. Сообщения до первой
  activation и во время закрытых промежутков никогда не становятся backlog. Уже принятые
  unresolved items остаются видимыми после deactivate; после provider disconnect они
  остаются read-only, а reconnect того же immutable provider account возвращает тот же
  namespace и требует новой явной activation. Другой account получает новый случайный
  `accountRef`, пустой allowlist и inactive Inbox.
  Identity refs типизированы и включают `channel + accountRef`; решения лежат в
  `accounts/<accountRef>/inbox-state.json`, назначают непересекающиеся точные множества
  message refs и переживают split/merge через coverage. `task`/`dismiss` принимают только
  непустой точный subset текущих `new` messages. Reset разрешён лишь для skipped decision
  с CAS по decision id/version; task reset запрещён, поскольку внешняя B24-задача уже
  создана. UI называет reset «Вернуть на разбор», отделяет очередь от истории и после
  stale CAS сам перечитывает карточку.
  Вложения materialize лениво перед автоматическим model triage или ручным task. Общий
  `InboxAttachmentAnalyzer` через `SpeechRuntime` разбирает voice/audio, для video добавляет
  bounded кадры, передаёт raster images модели и читает только bounded strict UTF-8
  документы. Лимиты — 12 файлов, 80 МБ суммарно и для Telegram 20 МБ на файл. Неполный
  разбор оставляет item человеку; bypass возможен только после отдельного ручного
  подтверждения и автомату запрещён. Недоверенный Inbox никогда не идёт через coding
  `executor.run`: только capability-gated `runUntrusted` без tools/workspace/MCP/session;
  visual path сервер проверяет внутри media cache и заменяет на bytes до provider boundary.
  Нет безопасного transport или image modality — fail-closed и worker не `ready`.
  Успешный hash-cache ограничен 512 МБ/30 днями, держит visual lease до чтения моделью
  и инвалидируется speech settings;
  неуспешный авторазбор показывается в карточке и получает шестичасовой cooldown.
  Успешная автоматическая B24-задача содержит только сформулированную постановку и source
  URL: исходные медиа на портал не загружаются, модель и причина остаются во внутреннем
  decision audit. Ручная постановка сохраняет прикладывание подготовленных файлов.
  B24 readiness проверяется до чтения канала;
  непосредственно перед внешним side effect повторяются generation, revision, contents,
  assignments, project, policy
  и plugin gates. Решение `task` пишется только после успеха B24. Неопределённое окно
  «B24 success, durable decision failed» блокирует автоматический retry и требует
  operator reconciliation.
  Один `InboxAutoTasks` живёт в `app.js` и использует общую модель из настройки плагина
  Inbox; старый Telegram-owned ключ модели не импортируется и не является fallback.
  `autoTask` остаётся свойством allowlist-правила конкретного источника: Telegram
  может автоматизировать одну тему, не автоматизируя соседнюю. Нет модели, низкая
  уверенность, превышенная quota, ошибка materialize/разбора/B24 или сомнение оставляют item
  человеку. Порог quota считается по точному policy scope, а не по всему каналу. Fair
  cursors продолжают bounded `perTick` обход после последнего model call и между каналами:
  нерешаемая голова очереди не закрывает глубокие обращения.
  Native activation windows page-ятся до safety cap 10 000; overflow fail-closed делает
  канал degraded без partial выдачи. Public limit применяется после decisions с приоритетом
  `new|mixed`, summary и action работают по полному authoritative scan.
- GitHub Issues (плагин канала «GitHub Issues», раздел `/github`): один repository,
  `GET /api/github/status`, `POST /api/github/{connect,recheck,disconnect}` и
  `GET/PUT /api/github/rules`. Connect проверяет repository через GitHub REST, связывает
  immutable `repository.id` с `accountRef`, создаёт выключенный repository webhook только
  на operator-owned HTTPS callback, затем включает его и ждёт подписанный ping. PAT и
  случайный HMAC secret хранятся только в private `server/.state/github-creds.json`;
  публичный ingress `/hooks/github/:ingressRef` проверяет HMAC по exact raw body до JSON.
  Принимается только `issues/opened` точного repository; pull requests, comments и
  attachments в v1 не входят. Dedupe durable по delivery id и semantic
  `repository.id + issue.id`; REST reconciliation после старта/connect и раз в пять минут
  закрывает потерянные webhook deliveries с bounded scan. REST edit уже известного issue —
  semantic no-op: первый snapshot остаётся immutable. Native mutations несут увиденный
  provider ID только как CAS и пишут исключительно через заранее взятый owner lease.
  Disconnect сначала отзывает
  ingress/leases и закрывает activation epoch, затем удаляет только известный remote hook;
  при недоступном GitHub локальный ingress уже закрыт, а cleanup остаётся явным pending.
  Binding, archive, rules, activation и decisions не удаляются; destructive purge в v1 нет.
- Вход: `GET /api/auth/state` (публичный), `POST /api/auth/{setup,login,logout,logout-all,password}`.
  Гард (`plugins/auth.js`) закрывает **весь** `/api` включая GET и WS-upgrade; публичны только
  `auth/{state,login,setup}` и служебный `/api/gateway/tls-allow`; даже `health` требует сессию.
  UI — `views/LoginView.vue` + таб «Доступ» в настройках.
- Система: `GET /api/system` (CPU% + RAM: сумма «ОЗУ+swap» для цифры в шапке и разбивка
  `ram*`/`swap*` для всплывашки с полосками); `GET /api/system/server` (режим запуска:
  systemd/вручную, по `INVOCATION_ID`), `POST /api/system/restart` (перезапуск кнопкой). Медиа: `GET /api/media/doctor`,
  `POST /api/media/upload` (multipart → распознавание), `GET /api/media/ingest/:jobId` (статус/транскрипт).
- Настройки: prefs — `GET/POST /api/settings/prefs`; диагностика фабрики —
  `GET/POST /api/settings/factory-debug`; B24 — `GET/POST /api/settings/b24` +
  `POST /api/settings/b24/test`; доверенные каталоги чат-исполнителей —
  `POST /api/settings/trusted-directories` (хранятся в prefs; поддержку объявляет сам
  адаптер полем `trustedDirectories`, поэтому UI берёт актуальные имена из `/api/providers`
  без хардкода; Claude/Codex применяют через `--add-dir`, Ollama — как корни файловых
  инструментов, Kimi — только в contained-режиме; глобальные конфиги CLI не меняются);
  порог автокомпакта чатов —
  prefs `chatAutoCompactWindow` (дефолт 200 000 токенов, `0` — не вмешиваться; Claude получает
  его через `executor.autoCompactEnv`, Codex — через `model_auto_compact_token_limit`);
  порог автосжатия контекста ЭТАПОВ конвейера — **своя** prefs `stageAutoCompactWindow`
  (тот же дефолт, но настройка отдельная: в чате сжатие рвёт нить разговора с человеком,
  на этапе — просто ужимает рабочий контекст). Уезжает движку переменной
  `FACTORY_STAGE_AUTO_COMPACT` **всегда, включая `0`** (`stageAutoCompactEnv` в
  `lib/factory-route-cli.js`, оба `spawnRouteEngine`): transient-юнит прогона не наследует
  окружение вовсе, а пустое значение движок читает как «спроси профиль» — осознанный ноль
  человека молча проигрывал бы `AUTO_COMPACT_WINDOW` проекта. Диалект CLI знает раннер
  движка, не кокпит (`docs/engine/ENGINE.md`);
  порог молчания хода конвейера — prefs `runSilenceWindow` (дефолт 900 секунд, `0` — не
  звать; едет в `/api/tasks` полем `silenceWindow`, замер молчания — полем `silence`
  сводки задачи). **Кокпит только оповещает, зависший ход не глушит** —
  см. `docs/cockpit/gotchas.md`;
  локальный HTTPS — prefs `accessLocalHttps`: решает при следующем старте, загружать ли
  выпущенный state-сертификат и поднимать `:8143`; выключение оставляет LAN-доступ по HTTP
  `:8140` и ничего не стирает. Прежний prefs `accessGateway` сохранён только для совместимости
  UI и НЕ управляет туннелями; внешний доступ показывается по setup/job/publicDomain и живой
  проверке, поэтому тумблера «выключить шлюз» без runtime API нет. TLS —
  `GET /api/settings/tls` (состояние: свой CA, лист, поднят ли
  сокет, нужен ли перезапуск), `POST /api/settings/tls/{generate,disable}` (`disable` — стереть
  выпущенное, это НЕ тумблер режима),
  `GET /api/settings/tls/{ca.crt,ca.svg}` (корень файлом и QR к нему — **без сессии**,
  но только клиентам из локальной сети: иначе корень нечем поставить на новое устройство);
  речь — `GET/POST /api/settings/speech`, отдельный CAS-gated
  `POST /api/settings/speech/browser-consent`, model jobs
  `/api/settings/speech/{models/:id/{download,copy},benchmark,jobs/:id}`;
  плагины — `/api/plugins*`. В UI табы:
  Битрикс24 / Исполнители / Запуски / Речь / Плагины / Сервер / Доступ.
  Терминал: `GET /api/terminal` (WebSocket, настоящий PTY; сообщения `in` и `resize`,
  размер меняется через `TIOCSWINSZ` + `SIGWINCH`). Реалтайм: `GET /api/events` (SSE).

## Ключевые решения (почему так)

- **Палитра — точная тёмная тема старого дашборда фабрики** (`#0b0d11/#151920/#5aa2ff/#3fb950/#e0a33a/#f0564c`).
  Кокпит закоммичен в dark.
- **Конвейер — порт `dashboard.py`**: `node_geom`/`edge_path` (12 типов кривых), `pipeline_statuses`
  (9 статусов узлов), `loop_facts` — портированы 1:1 в `lib/factory-graph.js` + `web/shared/graph-geom.js`.
- **B24 принадлежит Cockpit целиком:** сервер — единственный владелец портальной сессии,
  внешние действия идут через его HTTP/`bin/b24`; полный контракт — `docs/cockpit/b24.md`.
- **Мутации фабрики** — только через единый `factory`; `pipeline-set.sh` — внутренний
  ограниченный writer вторичной проекции, не внешний control-plane API.
  **flock на `orch.lock` НЕ использовать** (демон держит его весь прогон — дедлок). Контракт запуска —
  машинный (чтение `ORCH_PID`+`/proc`), не парсинг stdout.
- **Медиа-конвейер** (whisper/ffmpeg) живёт в Cockpit; установщик идемпотентно создаёт
  runtime-venv в `server/.state/media-venv` (gitignore) из закреплённых
  `server/requirements-media*.txt`, а путь фиксирует как `COCKPIT_MEDIA_PYTHON`.
  Модели разрешены каталогом с pinned revision и хранятся только в собственном
  `COCKPIT_MEDIA_HF_DIR` (`server/.state/hf` по умолчанию), не в пользовательском HF cache.
  Один `SpeechRuntime` обслуживает диктовку и видео; запуск распознавания fail-closed,
  если окружение или выбранная модель не готовы. Browser-auto требует явного consent перед
  первым запуском и серверной проверки актуальной revision перед каждым start/retry.
- **Вход — один пользователь, пароль scrypt-хешем в `.state`, сессия в httpOnly-cookie.**
  Закрыт весь `/api` (чтение тоже: чаты, дифы, а через терминал — шелл). Экран входа показывает
  само приложение по 401, серверных редиректов НЕТ — они конфликтуют с service worker'ом PWA.
  `COCKPIT_TOKEN` убран: он утекал в публичный бандл через `VITE_COCKPIT_TOKEN`.
- **Локальный HTTPS — второй сокет, а не переезд**: http `:8140` остаётся внутренней шиной
  (permission-tool чата, `bin/b24`, `bin/restart`, dev-прокси Vite, туннель шлюза) и полностью
  открыт для loopback, а https `:8143` слушает сеть. Тот же роутер (`fastify.routing`) и
  перенесённые слушатели `upgrade`. Клиентам из СЕТИ http отдаёт только корневой сертификат
  и QR к нему, остальное — `301` на https, вебсокет рвёт. Свой CA (ключ — вне репозитория,
  `~/.config/cockpit/ca`, с `nameConstraints`) + лист на 397 дней выпускаются из «Настроек»;
  сертификат читается один раз при старте, поэтому включение = выпуск + перезапуск.
  Для сертификата из состояния режим включается тумблером в карточке «В домашней сети»
  (prefs `accessLocalHttps`, читается в `app.js` до сборки): выключенный не поднимает сокет,
  но файлы не трогает. `COCKPIT_TLS_KEY/CERT` — системный override, UI им не управляет.
  Провал https не роняет процесс — иначе кнопка в браузере устраивает крэш-луп под
  `Restart=always`. Подробности — `docs/cockpit/gotchas.md`.
- **Доступ снаружи — шлюз на VPS + два обратных SSH-туннеля** (`deploy/gateway/bootstrap.sh` на VPS,
  `brain-setup.sh` на мозге; оба идемпотентные). Туннель исходящий, поэтому схема не зависит от
  CGNAT, провайдера и смены сети; это обычное TCP-соединение, поэтому существующий VPN не задет.
  Два туннеля, а не один: одно SSH-соединение мультиплексирует всё в один поток, и трафик стендов
  придавливал бы SSE с терминалом. Адреса стендов снаружи — **поддомен** `p<порт>.<домен>`
  (подпуть ломает Vite с `base: '/'`), диапазоны портов ограничены, перед стендами `forward_auth`.
  Режим за шлюзом включается `COCKPIT_TRUST_PROXY=127.0.0.1` (не `true`!) — от него зависят флаг
  `Secure` у cookie и реальный IP для лимита попыток. Первичная настройка пароля — только с
  localhost. Подробности и грабли — в `docs/cockpit/gotchas.md`.
- **Никаких хардкодов проекта в коде**: профиль из реестра, обнаружение профилей сканом
  `profiles/*/graph.json` через `config.profilesDir`, портал/креды из «Настроек»
  (`.state`), пути через config/env. Пустой кокпит
  ничего не знает о конкретном проекте.

## База знаний (как работает и тонкости — чтобы не перечитывать код)

@docs/cockpit/architecture.md
@docs/cockpit/b24.md
@docs/cockpit/inbox.md
@docs/cockpit/factory-graph.md
@docs/cockpit/chat-agents.md
@docs/cockpit/gotchas.md

## Запуск

```bash
deploy/install.sh                 # боевая установка (зависимости, сборка web, systemd, симлинк b24)
cd server && npm start            # dev-сервер (:8140)
cd web && npm run dev             # dev-фронт (:5180, проксирует /api на :8140)
bash tests/run-all.sh             # полный offline suite; без Cockpit и model call
```
Секреты (креды/куки B24) — в `server/.state/` (gitignore).

## Граница B24

Каноническое описание владельца сессии, CLI и протокола находится в
`docs/cockpit/b24.md`; внешнего B24-checkout у рабочего кода нет.
