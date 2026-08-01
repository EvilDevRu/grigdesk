# Архитектура кокпита

## Слои

```
web (Vue SPA / PWA)  ──HTTP/SSE──▶  server (Fastify, :8140 http + :8143 https)  ──▶  источники
                                     │
   Pinia stores                      ├─ adapters/factory-state ─▶ ~/.factory/state
   (chat, tasks, providers,          ├─ engine/bin/factory* ────▶ engine + CLI runners
    plugins, auth, system…)          ├─ adapters/b24 ────────────▶ B24Client (портал)
                                     ├─ adapters/system ───────▶ /proc/meminfo, os.cpus
                                     └─ adapters/media ────────▶ ffmpeg + python whisper
```

`*` — встроенный путь по умолчанию; внешний engine возможен только через явный config/env.

Сервер — **host-native** (см. [эксплуатационные грабли](gotchas.md)). Окна (браузер) ходят
на сервер по `VITE_BRAIN_URL`
(пусто = тот же origin). Реалтайм — SSE (`/api/events`), `fs.watch` на `~/.factory/state`.

## Модули сервера (`server/src/modules/`)

| Модуль | Эндпоинты | Источник |
|--------|-----------|----------|
| `factory` | `/api/tasks*`, `/api/factory/{routes,stages,slots}`, запуск/ворота/этапы/runner switch/стенд | `~/.factory/state` + `<factoryHome>/bin/factory` |
| `b24` | `/api/b24/{dashboard,task/:id,users}`, мутации `/api/b24/{tasks,task/:id/*}` | `B24Client` (через очередь `_run`) |
| `system` | `/api/system`, `/api/system/server`, `POST /api/system/restart` | `/proc`, `os`, systemd/manual launcher |
| `media` | `/api/media/{doctor,upload,ingest,ingest/:jobId,extract-frame}` | ffmpeg + whisper |
| `settings` | `/api/settings/{prefs,factory-debug,b24,trusted-directories,tls}` | prefs, engine debug CLI, `CredsStore`, `LocalTls` |
| `chat` | `/api/chat*`, `/api/tasks/:id/chat`, история/вложения/permission | выбранный executor + `chats/` ([детали](chat-agents.md)) |
| `agents` | CRUD `/api/agents[/:id]`, `POST /api/agents/reseed` | файлы `agents/<id>.md` (ШАБЛОНЫ: метаданные + заготовка промпта) |
| `routes` | `GET/POST /api/profiles`, immutable `/api/routes-v2/*` (current, revisions, catalog, route+graph, publish) | v2 bundles — `~/.factory/routes` (`COCKPIT_ROUTES_V2_DIR`); проекты кокпита — prefs |
| `providers` | `/api/providers*` (модели, usage/resources/actions, обновления CLI) | `lib/executors/*` + локальный реестр моделей |
| `analysis` | `/api/analysis*` | очередь и статус-файлы в `~/.factory/analysis` |
| `projects`, `code` | `/api/projects*`, read-only `/api/code/:project/*` | профили/prefs + git/worktree |
| `documents` | `/api/documents/{resolve,file}` | зарегистрированные read-only MD/TXT sources ([детали](documents.md)) |
| `plugins`, `demo` | `/api/plugins*`, `/api/demo*`, `/api/ext/<id>/*` | системный реестр + `plugins/<id>/` |
| `auth`, `gateway` | `/api/auth*`, `/api/gateway/{authz,tls-allow}` | сессии, CLI token, внешний Caddy |
| `terminal` | `/api/terminal` (WebSocket) | PTY |
| `health` | `/api/health` | — |

Fastify-плагины: `sse` (fs.watch → broadcast), `http-scope` (область http-сокета, когда поднят
https: с loopback — всё, из сети — только корневой сертификат и `301`), `auth` (весь `/api`, WS,
`/shots` и `/demo` закрыты сессией; исключения — login/setup/state, gateway TLS allow и выдача
корневого сертификата; локальные CLI используют `X-Cockpit-Token`), `static` (web/dist, кэш
index=no-cache, assets=immutable). Порядок важен: `http-scope` идёт ПЕРЕД `auth`, иначе устройство
из сети получало бы `401` вместо редиректа и не добиралось до экрана входа.

**Два сокета в одном процессе:** Fastify создаётся без опции `https`, второй сервер
(`lib/https-listener.js`) получает тот же роутер (`fastify.routing`) и перенесённые слушатели
`upgrade`. Что положить в сокет, решает `lib/tls-source.js`: `COCKPIT_TLS_KEY`/`COCKPIT_TLS_CERT`,
иначе — выпущенное из «Настроек» (`lib/tls-local.js`) и только при включённом тумблере режима
(prefs `accessLocalHttps`, читается в `app.js` до сборки: сокет создаётся один раз при старте).
Почему http остаётся полнофункциональным для loopback и чем это грозит,
если переставить — [gotchas](gotchas.md#локальный-https-два-сокета-в-одном-процессе-а-не-переезд-на-8143).

**Триаж (lib/analysis/analyzer.js), устойчивость:** очередь оценок при старте сервера
ВОССТАНАВЛИВАЕТСЯ из статус-файлов (`queued` → снова в очередь; `running` → interrupted,
перезапуск из бейджа топбара). Воркеров — `COCKPIT_ANALYSIS_CONCURRENCY` (дефолт 2);
git-refresh перед оценкой — не чаще раза в 10 мин (волна задач не дёргает pull каждый раз).
Одна оценка ~5–15 мин: очередь в 70 задач — это часы, «висит» ≠ сломано (смотри /api/analysis).

**Агенты и промпты (модель данных):** агент в `agents/` — переиспользуемый ШАБЛОН роли
(один id = один шаблон, коллизий и суффиксов `-<профиль>` больше нет, `.remap.json` умер).
Шаблон советует `tier` (КЛАСС модели: `reasoning|balanced|cheap`) и `effort`, но runtime их не
читает: исполняемая model policy остаётся в `profiles/<name>/runners.env`. Класс, а не семейство —
потому что база агентов общая, а проекты живут на разных исполнителях (arsenkin — claude,
rdesigner — codex): «opus» в общем шаблоне сверять с codex-профилем нечем. Соответствие
семейство↔класс объявляет сам исполнитель (`executor.familyClass`, у codex его нет — сверка
тогда честно пропускается), а валидатор маршрутов даёт warning `agent_tier_below_policy`, когда
профиль выдаёт этапу класс СЛАБЕЕ рекомендованного (сильнее — нормально, это выбор проекта).
Старое поле `model: opus|sonnet|haiku|fable` читается как класс и при первом сохранении
переписывается в `tier`.
Боевой промпт каждого этапа принадлежит СХЕМЕ: сайдкар `routes/<профиль>/<маршрут>/<этап>.md`.
При добавлении узла в конструкторе заготовка копируется из шаблона в схему (инстанцирование)
и дальше живёт своей жизнью; правка шаблона расставленные узлы НЕ меняет. В редакторе маршрутов
клик по узлу → «Промпт этапа» (кнопки «Из шаблона» и «Применить во все схемы» — разнести общий
текст, например уроки прогонов, по всем схемам проекта). Пустой промпт = сайдкар удаляется;
промпты в `<id>.json` не живут (только сайдкары). Startup-autoseed удалён. Legacy reseed
строит только read-only preview из `graph.json` и статических agent-файлов, не source-ит
`profile.sh`; apply отключён до атомарной миграции. Динамические prompt-ветки переносятся
вручную; общий shell extractor удалён.
У стадий-статусов профиля проекта (skeptic/validate/tcritic/simplify) промпт пуст ЗАКОННО — их ведут
промпты соседних стадий (plan/tests/build).

**Прогоны v2 в UI:** адаптер состояния читает ОБА дерева — legacy `state` и
`state-v2` (`config.stateV2Dir`); формат pipeline-файла одинаковый, поэтому список,
граф и логи v2-задач работают штатно, в сводке/графе есть `generation: v1|v2`.
Мутации v1-CLI (гейты, форс этапа, runner switch, снос песочницы, launch) по
v2-задаче — 409 `v2_task_engine_owned`: ею управляет только `factory-v2`.

**Маршруты v2:** `/api/routes-v2` — отдельный namespace и не подменяет legacy CRUD.
Хранилище опубликованных бандлов — `~/.factory/routes` (`config.routesV2Dir`), отдельно
от legacy-базы `<repo>/routes`: это runtime-артефакт движка, и движок (`factory-v2`)
читает тот же каталог по умолчанию. Без `routesV2Dir` в конфиге v2-store падает в общий
каталог с legacy (режим тестов; защищён гардами `badRouteId`/`removePromptSidecars`).
Route/catalog публикуются полным immutable bundle, exact bytes перечислены в manifest,
а `current.json` меняется через compare-and-swap. Catalog pin включает bootstrap Scout и
точные route hashes. Server валидирует schema при публикации и чтении; engine перед
исполнением делает независимую повторную проверку. Route schema описывает executor,
phase, policy, status owner, retry и все переходы, но запрещает `model`, `provider`,
`effort` и произвольный shell.

**UI-мелочи:** системный `confirm()` запрещён — единый `shared/ui/confirm.js`
(`await confirmDialog(text, {danger, okText})`, тёмная модалка проекта). Тултип исполнителя
в топбаре показывает потребление лимитов подписки (`/api/providers/usage` →
`executor.usage()`: у Claude — OAuth-ручка usage хостового CLI, у Codex — read-only
`account/rateLimits/read` официального `codex app-server`; кэш 60с). Запрос Codex не создаёт
ход и не вызывает модель. Ответ всегда структурирован: бары не исчезают при временной ошибке,
а помечаются устаревшими; 401/403, 429, отсутствие авторизации и отсутствие usage API имеют
отдельные сообщения и действия. Баланс, платное продолжение и заработанные сбросы описываются
provider-neutral массивом `resources`; его `toggle`/`number`/`button`/`link` контролы рисует
общий компонент. Мутации идут через
`POST /api/providers/:id/usage-actions/:actionId`: ядро разрешает только action из явного
`executor.usageActions`, а смысл и валидация принадлежат адаптеру. Поэтому новый исполнитель
не добавляет vendor-ветки в Fastify или Vue.

Модельный селектор использует каталоги исполнителей, а не список из компонентов: Claude
сканирует установленный бинарь, Codex читает read-only `model/list` app-server с доступом
текущего аккаунта. Живой Codex-каталог и открытый UI обновляются раз в минуту; hidden и
модели с рекомендованным `upgrade` показываются только при включённом «Показывать все модели».

## Данные фабрики

- Реестр прогона: `~/.factory/state/tNNNN.pipeline` — `KEY=VALUE` (не JSON), парс `lib/pipeline-parse`.
- Форма графа: `<config.profilesDir>/<profile>/graph.json` (по умолчанию локальный корневой
  `profiles/`, целиком вне Git) (`capabilities`, nodes/keys/optional/routes с pos+edges).
- Статусы узлов: `lib/factory-graph.computeNodeStatuses` — порт `pipeline_statuses` из `dashboard.py`.
- Возвраты: `parseLoops` из `logs/tNNNN.stages.log`. Порты стенда: `tNNNN.env`.
- Стадии — глобальный каталог `lib/stages.js` (enum), профиль оверрайдит подпись/тип.
- После запуска Cockpit модуль factory один раз проверяет незакрытые реестры. Мёртвый демон
  возобновляется только вне ворот/human-stall и с лимитом три рестарта за 15 минут;
  настройка `autoRecoverPipelines` отключает это поведение.

## Веб (`web/src/`)

- `views/`: Board (доска B24), Pipeline (конвейер + модалка этапа), Agents (база агентов-стадий),
  Chats (телеграм-раскладка чатов), Routes (редактор маршрутов + живой превью),
  Projects, Code (read-only дерево/файл/git), Documents (скрытый route просмотра MD/TXT),
  Diff (Monaco), Video, Demo, Terminal,
  Settings (Приложение / Битрикс24 / Исполнители / Запуски / Плагины / Сервер / Доступ), Login,
  TaskModal и ChatPanel.
- `views/pipeline/FactoryGraph.vue` — SVG-граф; геометрия/кривые в `shared/graph-geom.js`
  (порт `node_geom`/`edge_path`); автораскладка маршрутов — `shared/route-layout.js`.
- `stores/`: `board` (кеш доски + поллинг), `tasks` (кеш деталей + действия), `system`, `ui`
  (модалка задачи), `pwa` (обновление/установка и Screen Wake Lock текущего устройства),
  `chat` (мультисессии, история на сервере),
  `analysis`, `auth`, `diff`, `plugins`, `providers` (реестр исполнителей),
  `ui-context` (что открыто — для чата), `notify-watch` (что на конвейере встало на человеке).
- **Screen Wake Lock** — локальная настройка `cockpit-screen-wake-lock` во вкладке
  «Настройки → Приложение». Она не хранится в серверных prefs, чтобы планшет не менял
  энергоповедение остальных окон. `stores/pwa.js` держит блокировку на уровне всего SPA,
  а после системного освобождения в фоне повторяет запрос по `visibilitychange`.
- **Чипы «требует меня» в навигации** (`AppShell.vue`, карта `badges`: пункт → `{n, kind, title}`) —
  одно правило на все разделы. Жёлтый пульсирующий (`wait`) — работа СТОИТ, пока не подойду
  (вопрос агента в чате, ворота конвейера); красный (`stall`) — конвейер упёрся или оборвался,
  своей кнопки там нет, надо разбираться; синий — просто непрочитанное. Видны и в свёрнутом
  сайдбаре, и в нижней навигации на мобиле; подсказка перечисляет задачи поимённо.
  Источники: чаты — `chat.waitingCount`/`unreadCount`
  (см. [чат с агентами](chat-agents.md)), конвейер —
  `notify-watch` (он и так обходит `/api/tasks` + `/api/tasks/:id/graph` ради оповещений —
  второго обхода ради цифры не заводим; обновляется по SSE `state-change` + 120-секундная
  страховка). Цифра конвейера — ЗАДАЧИ, а не поводы: задача, которая и ждёт у ворот, и числится
  вставшей, считается один раз.
- `shared/pipeline-wait.js` — единственный ответ на «чего конвейер ждёт от человека»
  (`waitingReason` + расшифровки ворот `GATE_REASON`). Общий для страницы конвейера, вотчера
  оповещений и чипа: цифра чипа обязана сходиться с «⏳ ждут тебя» на странице. Копий этой
  логики было две, и они уже разошлись в мелочах.

## Граница B24

Доска и действия используют локальный `B24Client`, медиа — локальный pipeline, вход в
фабрику — `engine/bin/factory`, CLI — `bin/b24`. Резервный
Python-dashboard тоже использует Cockpit `B24Client` и хранилище кредов, но держит отдельный
cookie jar, чтобы два процесса не перезаписывали один файл. Прямых путей к внешнему checkout
в рабочем коде нет; внешние host hooks/settings/containers находятся вне репозитория.

## Плагины кокпита

Плагин = отключаемый блок: пункт в сайдбаре (под разделителем после основного nav), плашка
в «Настройки → Плагины», свои API/настройки. Реестр: `lib/plugins-registry.js` (SYSTEM =
video, demo, code) + скан пользовательских `plugins/<id>/plugin.json` (+опц. `server.js`, роуты
в ЖЁСТКОМ префиксе `/api/ext/<id>/` (механика Fastify, перекрыть системное нельзя), контракт версионирован полем `api` (=1), регистрация на старте — вкл/выкл требует рестарта, у системных нет).
Состояние — prefs (`plugins`, `pluginSettings`). Модуль `modules/plugins/` декорирует
`fastify.pluginEnabled(id)` / `fastify.pluginSettings(id)` — регистрируется ДО модулей-плагинов;
системные модули (media, demo, code) гейтят каждый роут живой проверкой (тумблер без рестарта → 404
plugin_disabled). Диктовка чата (`/api/chat/transcribe`) НЕ входит в плагин video — не гейтится.
Фронт: `stores/plugins.js`, DemoView/VideoView/CodeView показывают заглушку при выключенном плагине.
Вкладка «Настройки → Плагины»: карточки горизонтальной сеткой (auto-fill 340px), селекты
настроек — стилизованные (appearance:none + свой шеврон), НЕ нативные. Все подтверждения
действий (снос стенда, форс этапа) — через confirmDialog, системный confirm() запрещён.

## Демо вне конвейера

Демо УБРАНО из цепочки фабрики (хвост bin/factory: ship → сразу ретро). Съёмка — плагин «Демо»
(`/demo`): `POST /api/demo/:id/run` → `factory <task> demo` (одиночный прогон DEMO-агента в
transient scope `factory-demo-tNNNN`), статус — ключ DEMO реестра (running→done|failed), фронт
поллит `/api/demo/overview` (задачи+стенды+ролики из `~/.factory/state/demo`). В реестре остался
ОДИН ключ — `DEMO`, и пишет его только режим demo. Ворота `DEMO_ASK`/`GATE_DEMO` выпилены
целиком (2026-07-27): из `--init` реестра, из `ROUTE_STAGES.feature`, из каталога стадий
`lib/stages.js`, из `GATE_REASON` и из эндпоинта ворот — он снова принимает только `GATE_*`.
Пока они числились этапами маршрута, прогресс feature не доходил до 100%, а дашборд фабрики
ждал ответа на вопрос, которого движок больше не задаёт.

## Авторизация и CLI-токен

Весь `/api` за сессией (httpOnly cookie). Для локальных CLI (bin/b24, ship-этап фабрики,
скиллы) — `server/.state/cli-token` (0600, создаётся сервером): заголовок `X-Cockpit-Token`.
`bin/b24` сам читает токен от РЕАЛЬНОГО пути скрипта (readlink -f, симлинк из ~/.local/bin).
Внутренний `internalToken` (in-memory, per-process) — только для permission-mcp чата.

## Авто-шип фабрики

SHIP-этап arsenkin-профиля публикует сам: чистка диффа → merge origin/master (конфликт →
abort + пометка, решает PR) → тесты → коммит `Task NNNN - ...` (без Co-Authored-By) → push →
`gh pr create` (существующий PR не дублирует) → `b24 comment` со ссылками → итог в ship.md.
Права: PROFILE_AGENT_ALLOW += gh pr create/view/list, b24. Не запушил → SHIP failed.
