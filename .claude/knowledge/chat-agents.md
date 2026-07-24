# Чат с агентами, базы agents/routes, реестр исполнителей

## Чат (modules/chat)

- Запуск: `claude -p <msg> --output-format json --permission-mode plan [--model][--effort][--resume sessionId]`.
  По задаче — cwd = worktree задачи (`factoryState.readEnv`: BE_WT + FE_WT через `--add-dir`), без задачи — корень фабрики.
- `contextTokens` = input + cache_read + cache_creation последнего ответа; окно 200k захардкожено во фронте (`CONTEXT_WINDOW`).
- Память агента — в сессиях Claude CLI на хосте; кокпит хранит только `sessionId`.
- **Пустой ответ («пусто»):** `claude -p` может вернуть result без текста — агент завершил ход
  tool-call'ом, который plan-режим запретил (Bash/Write и т.п.), или упёрся в лимит шагов.
  Сервер маппит это в понятное «⚠ …»-сообщение (по `subtype` и `permission_denials`) и пишет
  warn в лог. Типичный триггер: просьба «сделай/запусти/разбери файл» — чат только читает.
- Один Pinia-стор `chat` питает и плавающую панель (ChatPanel, есть на всех страницах, кроме `/chats`), и страницу «Чаты» (ChatsView, телеграм-раскладка: ChatList-сайдбар + ChatSession).
- **Слэш-команды**: ввод «/» в композере открывает меню с описаниями (фильтр по мере набора,
  ↑/↓ + Enter/Tab, Esc, клик). Команды клиентские, на сервер не ходят: `/clear` — история+контекст,
  `/reset` — только контекст, `/new` — новый чат. Список — const `COMMANDS` в ChatSession.vue.
  **Грабля:** класс выделения строки меню — `on`, не `sel` (`.sel::after` в этом же файле рисует шеврон селектов).

### Хранилище истории — chats/ в корне проекта

- Каждый чат — файл `chats/YYYY-MM/<id>.json` (месяц СОЗДАНИЯ чата — файл не переезжает), мета — `chats/meta.json`, внутри самогитигнор (`*` + `!.gitignore`).
- Запись атомарная (tmp+rename) и только изменившихся чатов (сравнение JSON); битый файл пропускается с warn — теряется один чат, не вся история.
- Миграции одноразовые: localStorage (`cockpit-chat-v2`) → серверный файл → пофайлово; legacy `server/.state/chats.json` переименован в `.migrated`.
- Между окнами — last-write-wins всего стора (принятое ограничение).
- **Индикация активных агентов**: сервер держит `activeRuns` (chatKey→startedAt/tokens),
  `GET /api/chat/active`; фронт при загрузке восстанавливает «думает… · N ток.» после F5,
  SSE `chat-progress` тоже поднимает sending, `chat-done` гасит во всех окнах. Бейдж-счётчик
  на пункте «Чаты» в навигации, спиннер в аватаре чата в списке.
- **Оформление ответов агента**: подпись «✳ Агент» + акцентная полоска слева, текст рендерится
  маркдауном (`shared/md.js`, HTML экранируется) — отличимо от системных плашек и пузырей.
- **Usage-корзины**: каноничный источник — массив `limits` ответа oauth/usage (из него строится
  официальная панель): `session`, `weekly_all`, `weekly_scoped` (+`scope.model.display_name`,
  например «Fable» — модельные недельные ведра приходят сами, хардкода имён нет).
  `extra_usage` — доплата сверх лимитов, отдельный бар с бюджетом («61 из 170 EUR»).
  Верхнеуровневые ведра (`five_hour`…) — только фоллбэк. Сеть до api.anthropic.com флапает
  (VPN): retry ×2 + при сбое отдаются прошлые данные, а не пустота.
- **Недоставленные ответы**: если клиент умер во время работы агента (F5/закрытие вкладки),
  сервер по завершении видит `request.socket.destroyed` и пишет ответ в `chats/pending/<id>.json`
  (+SSE `chat-orphan` живым окнам). Фронт при `_load()` и по этому событию забирает
  GET /api/chat/pending, раскладывает по чатам (dedup по `pid` в сообщении) и подтверждает DELETE'ом.
  Ошибки тоже доезжают (role: error). Навигация внутри SPA ответы не теряет и без этого —
  стор глобальный, запрос переживает переключение чатов/разделов.

### Всплывашка разрешений (аналог permission prompt Claude Code)

- Чат работает в `--permission-mode default`: чтение свободно, на действия (Bash/правки) claude
  спрашивает через `--permission-prompt-tool mcp__cockpit-perm__approve` — мини-MCP
  `lib/chat/permission-mcp.js` (newline-JSON-RPC вручную, без SDK), который держит HTTP-запрос
  к `/api/chat/permission-request`, пока пользователь не ответит.
- Поток: claude → MCP → POST permission-request → SSE `chat-permission {pid,tool,input,chatKey}` →
  всплывашка в ChatSession (жёлтая, показывает команду/файл) → POST `/api/chat/permission/:pid`
  {allow} → `chat-permission-done` закрывает всплывашку во всех окнах. Таймаут 4 мин → deny.
- **Нюанс:** то, что уже в глобальном allowlist пользователя (~/.claude/settings.json), выполняется
  БЕЗ всплывашки — prompt-tool зовётся только для того, что иначе спросило бы.
- Чекбокс «Разрешать до конца сессии»: карта chatKey→Set(tool) в памяти вкладки (chat.js,
  `permAutoAllow`) — совпавшие запросы отвечаются allow автоматически, в allowlist ничего не пишется.
- **Живой счётчик токенов**: claude запускается с `--output-format stream-json --verbose`,
  executor суммирует output_tokens по assistant-событиям → onProgress → SSE `chat-progress
  {chatKey, tokens}` → «думает… · N ток.» в чате.
- Перезапуск сервера — ТОЛЬКО `bin/restart` (гасит порт, ждёт освобождения, стартует, health-чек):
  в репо работают параллельные сессии, ручные kill+start ловили EADDRINUSE и рвали чужие чат-запросы.

### UI-контекст: чат знает, где пользователь

- Стор `ui-context` (`web/src/stores/ui-context.js`): страницы репортят детали `set(key, val)`/`clear(key)`
  (маршрут в Routes, таб в Settings…). `chat.send()` прикладывает `{ page, path, details }` из роутера + стора.
- Сервер (`pageMode`/`contextPrefix` в modules/chat) строит блок `[Контекст кокпита]` перед сообщением: страница,
  подсказка о её данных, детали. Явно указано: контекст задействовать только если просьба к нему относится.
- **Режим страницы «Агенты»** (чат без задачи): cwd = `agents/`, `--permission-mode acceptEdits` —
  «поправь этого агента» реально редактирует `<id>.md`. Остальные страницы — plan (только чтение).

### Вложения (фото) и диктовка

- **Вложения:** кнопка-скрепка, drag&drop на весь чат (оверлей «Отпусти, чтобы приложить»;
  dragenter/leave через счётчик — leave стреляет на каждом дочернем узле) или вставка
  картинки из буфера → сразу `POST /api/chat/upload`
  (multipart) → файл в `chats/attachments/<ts>-<имя>` (гитигнорится вместе с chats/). К сообщению
  клиент прикладывает `attachments: [{file, name}]`; сервер строит пути ТОЛЬКО внутри attachments/
  (защита от traversal/произвольного `--add-dir`), добавляет `--add-dir chats/attachments` и блок
  `[Вложения]` со списком путей — агент смотрит их инструментом Read (vision работает в plan-mode).
  Сообщение без текста, но с вложением — валидно. Превью в истории — `GET /api/chat/attachment/:file`.
- **Диктовка:** кнопка-микрофон (SVG; запись — красный пульс + квадрат-стоп, расшифровка —
  только спиннер на кнопке, без текстов) — MediaRecorder (webm/opus) → `POST /api/chat/transcribe` →
  синхронно ffmpeg→wav→faster-whisper (переиспользует `ingestRecording` из lib/media, модель medium,
  ~14с на 8с речи вкл. загрузку модели) → текст дописывается в поле ввода (не отправляется сам).
  **Грабля:** getUserMedia требует secure context — по http://<tailscale-ip> микрофон недоступен
  (кнопка покажет подсказку); работает на localhost или через https.

## База агентов (modules/agents) — стадии конвейера

- `agents/<id>.md` в корне проекта (самогитигнор): frontmatter (kind/label/sub/key/model/timeout/budget/readonly/optional) + тело-промпт. Формат плоский key: value — парсер свой (`store.js`), не YAML-библиотека.
- CRUD: `GET/POST /api/agents`, `GET/PUT/DELETE /api/agents/:id`, `POST /api/agents/reseed`.
- Пустая база один раз засевается из фабрики (каталог стадий + профиль + graph.json); reseed перетирает стадии, кастомных не трогает.
- UI: AgentsView (`/agents`) — список + редактор карточки; «Профи»-настройки за тумблером.

## База маршрутов (modules/routes)

- `routes/<id>.json` в корне проекта (самогитигнор): `{ title, stages: [agentId…], returns: [{from,to,label}] }`.
  Координат нет — схема рисуется автораскладкой (`web/src/shared/route-layout.js`).
- CRUD: `GET/POST /api/routes`, `PUT/DELETE /api/routes/:id`. Посев из фабрики: цепочка — порядок узлов graph.json, возвраты — fail-рёбра.
- UI: RoutesView (`/routes`) — редактор: чипы-цепочка с drag, возвраты, живой SVG-превью.

## Исполнители и модели (modules/providers + lib/executors + lib/models-registry)

- **Подключение нового ИИ — модульное:** один файл в `server/src/lib/executors/` (контракт в
  `executors/index.js`: id/name/color/probe/auth/efforts/seedModels/run). Папка сканируется при
  старте — ядро (providers, chat) про вендоров не знает. Сейчас: `claude.js`, `codex.js` (GPT).
- `GET /api/providers` — `{ id, name, vendor, bin, color, version, auth, authLabel, available, installed, models[] }`.
  Кэш 60с, `?refresh=1`. Топбар рисует иконки (серый = недоступен), настройки → вкладка «Исполнители».
- **Реестр моделей — БЕЗ хардкода в компонентах:** сид из executors сеется в РЕДАКТИРУЕМЫЙ
  `server/.state/models.json` (новая модель = строка в json, код не трогаем; новый executor
  досеивается без перетирания правок). У модели: `id` (что передаём CLI), `name` (с версией — UI),
  `context` (окно — кольцо контекста считается от него), `efforts[]` (свои уровни — слайдер
  строится по ним, xhigh отображается как «Ultra»), `tier` (сила; сортировка desc — сильнейшая сверху).
- **Эффорты Claude обнаруживаются динамически** парсингом `claude --help` (появится ultra — подхватится).
- **Новые модели Anthropic обнаруживаются сами** (`claude.js discoverModels` → `/v1/models`):
  вотермарк по `created_at` в `_meta` models.json — всё, что свежее и неизвестно, дописывается
  наверх списка (tier выше максимума). Авторизация: `ANTHROPIC_API_KEY` из окружения, либо
  OAuth-токен хостового CLI — ТОЛЬКО при явном опт-ине `COCKPIT_DISCOVER_WITH_CLI_TOKEN=1`
  (без него сервер в чужие креды не лезет). У GPT — то же самое через `OPENAI_API_KEY`
  (`codex.js discoverModels`, /v1/models с фильтром не-чатовых); OAuth-токен codex к platform-API не подходит.
- **Грабли:** алиаса `fable` в CLI нет — только полный ID `claude-fable-5` (алиасы opus/sonnet/haiku
  работают). `execFile` без закрытия stdin вешает `claude -p` (ждёт ввода → 5-мин таймаут) —
  в executors всегда `child.stdin.end()`. Fable агентен: даже на простой вопрос может пойти
  в репо и запросить разрешения — таймаут всплывашки 240с, execFile 300с.
- Чат: селект — optgroup по исполнителям, недоступный ИИ виден, но options disabled. Сервер выбирает
  executor по модели (`providerOfModel`); GPT без бинаря → понятная ошибка «npm i -g @openai/codex && codex login».
- **Смена ИИ внутри чата** (claude ↔ gpt): sessionId прежнего исполнителя несовместим — фронт
  сбрасывает контекст автоматически (история чата остаётся). Конфликтов между ИИ нет: каждый
  запуск — отдельный процесс, сессии в реестрах своих CLI.
- Настройки → «Исполнители»: у недоступного показана команда установки (из `executor.install`);
  клик по ней открывает раздел «Терминал» с уже введённой командой (механизм —
  `sessionStorage['cockpit-term-insert']`, TerminalView печатает её в PTY при коннекте, Enter — за пользователем).
- Тултипы — единый компонент `shared/ui/HelpTip.vue` (слот-триггер): топбар (исполнители, IP,
  CPU/RAM, хост) и микрофон чата на нём; системные title там больше не используем.
- Codex: `codex exec --json` (JSONL), резюме `exec resume <thread_id>`, песочница read-only (своей
  всплывашки разрешений у codex-exec нет). Авторизация = наличие `~/.codex/auth.json`.
- **Не путать**: `/api/agents` — агенты-стадии (промпты), `/api/providers` — LLM-движки, которые их исполняют.

## Авторизация Claude

- Настройки НЕ управляют ключом (форма удалена вместе с `/api/settings/claude*`); чат работает от хостового CLI
  (`claude login`) либо от ключа в `server/.state/claude-auth.json`, если тот был задан раньше (`ClaudeAuthStore` жив).
