# Архитектура кокпита

## Слои

```
web (Vue SPA / PWA)  ──HTTP/SSE──▶  server (Fastify, :8140 http + :8143 https)  ──▶  источники
                                     │
   Pinia stores                      ├─ adapters/factory-state ─▶ ~/.factory/state
   (chat, tasks, providers,          ├─ engine/bin/factory* ────▶ engine + CLI runners
    plugins, auth, system…)          ├─ adapters/b24 ────────────▶ B24Client (портал)
                                     ├─ adapters/system ───────▶ /proc/meminfo, os.cpus
                                     └─ SpeechRuntime/media ───▶ ffmpeg + local python whisper
```

`*` — встроенный путь по умолчанию; внешний engine возможен только через явный config/env.

Сервер — **host-native** (см. [эксплуатационные грабли](gotchas.md)). Окна (браузер) ходят
на сервер по `VITE_BRAIN_URL`
(пусто = тот же origin). Реалтайм — SSE (`/api/events`), `fs.watch` на `~/.factory/state`.

Речь имеет один серверный lifecycle: `app.js` создаёт `SpeechRuntime` и инъецирует его в
chat/media/settings. Runtime разрешает валидированный preset в полный immutable job,
задаёт каждому Python-процессу собственный `HF_HOME`, проверяет pinned snapshot без сети
и закрывается вместе с Fastify. Тот же runtime владеет model-job coordinator и при каждом
capability read подбирает завершившиеся detached jobs, поэтому chat, settings и media doctor
видят один cache state. Настройки лежат в prefs, но model-job progress — в отдельных
атомарных status-файлах 0600 внутри каталога 0700: частые обновления загрузки не
переписывают prefs. Restart recovery удерживает dedupe до подтверждённой смерти прежнего
worker по полной process identity.

## Модули сервера (`server/src/modules/`)

| Модуль | Эндпоинты | Источник |
|--------|-----------|----------|
| `factory` | `/api/tasks*`, `/api/factory/{routes,stages,slots,runners}`, запуск (с выбором runner)/ворота/этапы/runner switch+override/стенд, `POST /api/tasks/:id/arbitrate` — арбитр типизированной остановки | `~/.factory/state` + `<factoryHome>/bin/factory` |
| `b24` | `/api/b24/{dashboard,task/:id,users,groups}`, мутации `/api/b24/{tasks,task/:id/*}` | `B24Client` (через очередь `_run`) |
| `task-favorites`, `task-shelf`, `task-seen` | `GET /api/b24/task-favorites` + `PUT/DELETE .../:taskId`, `GET/PUT/DELETE /api/b24/task-shelf[/:taskId]`, `GET/POST /api/b24/task-seen` | личное состояние человека (избранное, полка, «просмотрено») — отдельные schema-versioned файлы по opaque-scope аккаунта портала ([детали](b24.md#личное-состояние-задач-избранное-полка-и-просмотренное)) |
| `system` | `/api/system`, `/api/system/server`, `POST /api/system/restart`, `GET/POST /api/system/web-rebuild` (пересборка web-бандла из рабочего дерева) | `/proc`, `os`, systemd/manual launcher |
| `media` | `/api/media/{doctor,upload,ingest,ingest/:jobId,extract-frame,plan-tasks,frame/:run/:file,clip,clip/:run/:file}` | общий `SpeechRuntime`, ffmpeg + локальный whisper; хранилище раздела — `lib/media/storage.js` (запись кладётся по содержимому, уборка по возрасту, занятое место в `doctor`); разбор расшифровки на черновики задач — `runUntrusted` выбранной модели, кадр и фрагмент записи к задаче — декораторы `mediaFramePath`/`mediaClipPath`, байты фрагмента отдаются с Range ([детали](video.md)) |
| `settings` | `/api/settings/{prefs,factory-debug,b24,trusted-directories,tls,speech*}` | prefs, speech capabilities/model jobs, engine debug CLI, `CredsStore`, `LocalTls` |
| `chat` | `/api/chat*`, `/api/tasks/:id/chat`, история/вложения/permission, `/api/chat/transcribe*` | выбранный executor + `chats/`; процесс исполнителя живёт между ходами (`lib/chat/live-sessions.js`; список и гашение — `/api/chat/sessions`), непрошеный ход агента едет через `chats/pending`; browser/локальная диктовка использует тот же speech-контракт ([детали](chat-agents.md)) |
| `agents` | CRUD `/api/agents[/:id]`, `POST /api/agents/reseed` | файлы `agents/<id>.md` (ШАБЛОНЫ: метаданные + заготовка промпта) |
| `routes` | `GET/POST /api/profiles`, immutable `/api/routes/*` (current, revisions, catalog, route+graph, publish) | v2 bundles — `~/.factory/routes` (`COCKPIT_ROUTES_DIR`); проекты кокпита — prefs |
| `providers` | `/api/providers*` (модели, usage/resources/actions, обновления CLI) | `lib/executors/*` + локальный реестр моделей |
| `analysis` | `/api/analysis*` | очередь и статус-файлы в `~/.factory/analysis` |
| `projects`, `code` | `/api/projects*`, `/api/code/{roots,:project/*}`: чтение дерева/дифа, stage/unstage, commit, push и генерация названия | профили/prefs + git/worktree + выбранный `runUntrusted` executor |
| `documents` | `/api/documents/{resolve,file}` | зарегистрированные read-only MD/TXT sources ([детали](documents.md)) |
| `inbox` | `GET /api/inbox[/{summary,status}]`, `POST /api/inbox/channels/:channel/{activate,deactivate}`, решения `POST /api/inbox/items/:ref/{task,dismiss,reset}` | общий merge Telegram/GitHub, account-owned `inbox-state.json`, единый draft/triage/worker и B24 task service; provider credentials здесь отсутствуют |
| `telegram` | `GET /api/telegram/{status,chats}`, `GET/PUT /api/telegram/rules`, отдельный CAS `PUT /api/telegram/rules/agent-search`, `POST /api/telegram/{connect,recheck,disconnect,expand,service-chat}`, пульт `POST /api/telegram/pult{,/confirm,/disable}` + декоратор `telegramDiscussion` | Bot API (`getMe` + account-aware long polling), active token в private state; bindings и `accounts/<accountRef>/{state.json,archive/,rules.json,bot-settings.json,pult-state.json,inbox-state.json}` — `config.telegramDir` |
| `github` | `GET /api/github/status`, `GET/PUT /api/github/rules`, CAS `PUT /api/github/rules/agent-search`, `POST /api/github/{connect,recheck,disconnect,force-forget}`, public HMAC ingress `POST /hooks/github/:ingressRef` | GitHub REST + repository webhook `issues/opened`; PAT/secret в private state, bindings и `accounts/<accountRef>/{archive/,ingress-state.json,rules.json,inbox-state.json}` — `config.githubDir` |
| `plugins` | `/api/plugins*`, `/api/ext/<id>/*` | системный реестр + `plugins/<id>/` |
| `auth`, `gateway` | `/api/auth*`, `/api/gateway/{authz,tls-allow}` | сессии, CLI token, внешний Caddy |
| `terminal` | `/api/terminal` (WebSocket: `in`, `resize`) | stdlib Python helper: `pty.fork()`, `TIOCSWINSZ`/`SIGWINCH`, cleanup process group |
| `health` | `/api/health` | — |

Fastify-плагины: `sse` (fs.watch → broadcast), `http-scope` (область http-сокета, когда поднят
https: с loopback — всё, из сети — только корневой сертификат и `301`), `auth` (весь `/api`, WS,
`/shots` закрыт сессией; исключения — login/setup/state, gateway TLS allow и выдача
корневого сертификата; локальные CLI используют `X-Cockpit-Token`), `static` (web/dist, кэш
index=no-cache, assets=immutable). Порядок важен: `http-scope` идёт ПЕРЕД `auth`, иначе устройство
из сети получало бы `401` вместо редиректа и не добиралось до экрана входа.

**Два сокета в одном процессе:** Fastify создаётся без опции `https`, второй сервер
(`lib/tls/https-listener.js`) получает тот же роутер (`fastify.routing`) и перенесённые слушатели
`upgrade`. Что положить в сокет, решает `lib/tls/source.js`: `COCKPIT_TLS_KEY`/`COCKPIT_TLS_CERT`,
иначе — выпущенное из «Настроек» (`lib/tls/local.js`) и только при включённом тумблере режима
(prefs `accessLocalHttps`, читается в `app.js` до сборки: сокет создаётся один раз при старте).
Почему http остаётся полнофункциональным для loopback и чем это грозит,
если переставить — [gotchas](gotchas.md#локальный-https-два-сокета-в-одном-процессе-а-не-переезд-на-8143).

**Общий Inbox (`lib/inbox/`): immutable account context вместо mutable current.**
`app.js` явно композирует Telegram и GitHub capabilities. Каждый list/action захватывает
lease конкретных `accountRef + generation + stores`, а перед ответом или commit повторно
проверяет generation. Switch переводит старую generation в draining, запрещает новые
leases и ждёт уже начатые account-scoped операции. Ошибка одного канала попадает в partial
result и не скрывает второй.

Provider connect/disconnect, plugin toggle и Inbox activate/deactivate — три разные оси.
Activate атомарно открывает account-owned epoch по server-side marker; deactivate закрывает
её. История до activation и gaps намеренной паузы backlog не становятся. Закрытые epochs
продолжают показывать уже принятые unresolved items; после provider disconnect они read-only.
Reconnect той же immutable provider identity возвращает тот же namespace, но требует новой
явной activation; новый bot/repository ID получает новый случайный `accountRef`, пустые rules
и inactive Inbox.

Refs кодируют schema, kind, channel и account owner. Decisions назначают точные sorted unique
sets message refs без пересечений; split/merge проецируется coverage и частичное решение даёт
`mixed`. Task/dismiss принимают только непустой exact subset текущих `new` сообщений. Reset
возможен только для skipped по CAS; task reset запрещён. Перед B24 side effect task service
повторно проверяет B24 readiness, plugin/channel gates, generation, revision, contents,
assignments, project и policy. Решение пишется после B24 success; неоднозначный провал durable
commit блокирует автоматический retry до operator reconciliation.

**Каналы.** Telegram группирует по месту разговора (тема, иначе чат) с окном тишины 600 секунд и умеет
лениво materialize Bot API attachments. Общий `InboxAttachmentAnalyzer` до model triage/B24
локально транскрибирует речь, извлекает bounded кадры видео, готовит raster visual inputs и
читает bounded UTF-8 документы; неподдерживаемый или неполный разбор fail-closed оставляет
item человеку — с названной причиной по каждому вложению (канал даёт машинный код, фразу
собирает `lib/inbox/skip-reason.js`) и возможностью поставить задачу вручную через
пояснение оператора, которое уходит в тот же триаж. Ручная кнопка при настроенной модели
формулирует постановку тем же verdict-триажем; отказ модели её не запирает — задача
уезжает текстом обращения. Недоверенный Inbox не запускается
через coding executor: отдельный
`runUntrusted` не имеет tools/workspace/MCP/session, а visual realpath проверяется внутри
server-owned media cache и превращается в media type + base64 до границы provider-а.
Provider/модель без такого transport или image capability остаются fail-closed и не дают
worker readiness `ready`. Cache анализа bounded по TTL/quota; visual artifacts защищены
consumer lease до чтения моделью, а неуспешный item получает видимый шестичасовой cooldown.
GitHub v1 даёт один item на `issues/opened`, `settleMs=0`
и без attachments. GitHub ingress проверяет HMAC по raw body, exact repository/hook/generation
и durable delivery+semantic dedupe; bounded REST reconciliation восстанавливает потерянные
webhook deliveries. Общий `InboxAutoTasks` использует модель из плагина Inbox, а включение,
порог и quota остаются policy конкретного allowlist scope. Модель отвечает планом разбиения
карточки на поводы, поэтому одно обращение может дать несколько задач на непересекающихся
подмножествах сообщений. Любая неопределённость оставляет соответствующие сообщения человеку.
Загрузка исходных файлов в B24 — отдельная от разбора ось: галки `attachPhotos`/`attachVideos`
плагина Inbox читаются перед самой отправкой, автомату выдаётся только разрешённое, у человека
они снимают запрещённое. SSE `inbox-changed` будит все окна; минутный poll summary нужен отдельно,
поскольку Telegram item может созреть без нового события. Полный lifecycle, identity,
storage и operator gates описаны в [inbox.md](inbox.md).

**Телеграм-пульт** (`lib/telegram/pult/`) — живая картина конвейера и кнопки решений
в подтверждённой кодом личке владельца, тем же ботом и тем же поллером
(читатель getUpdates один; `callback_query` принимает общий цикл). Вотчер импортирует
те же `web/src/shared/{pipeline-wait,agent-activity}.js`, что чип навигации, слушает
шину через `fastify.sse.subscribe` и ходит в те же ручки через inject; действия
транслируются в существующие gate/permission/resume с CAS на сервере. Три сорта
сообщений: тихая живая карточка попытки (правится на месте — узел, прогресс, активность
агента), звонок об исходе прогона (правка push не даёт) и карточки «работа стоит на
тебе». Оповещение — на переходе, первый снимок silent, state и `message_id` карточек
переживают рестарт в `pult-state.json`; навигация живёт в одном правимом на месте
сообщении-экране и в постоянной reply-клавиатуре (Конвейер · Агент · Задачи · Ещё,
`setMyCommands`/`ReplyKeyboardRemove` — только со scope лички владельца), решённые
карточки поводов удаляются (итог — всплывашкой или эфемерным сообщением), карточки
прогона `sticky` и не удаляются ни уборкой, ни `/clean`. Свободный текст и голос
владельца — обычный auto-ход в server-owned companion-чате (`pult/assistant.js`:
ensure → CAS-сохранение обеих реплик → POST /api/chat без `companionTurn`/`dontAsk`/
`bypassPermissions`, неблокирующе для поллера; во время хода — только `typing`,
«Стоп» по chatKey после 30 с, итог одним сообщением; «Сжать»/«Сбросить память» —
через существующие `/api/chat/compact` и `/api/chat/session/reset`). Ход не переживает
перезапуск сервера: после старта marker сверяется с `/api/chat/active`. Мутаций две —
resume и пересборка стенда, обе вторым тапом с TTL. Постановка
задач принадлежит Входящим, запуск прогонов, деньги, goto, снос и закрытие — кокпиту.
Полный контракт — [telegram-pult.md](telegram-pult.md).

**Триаж (lib/analysis/analyzer.js), устойчивость:** очередь оценок при старте сервера
ВОССТАНАВЛИВАЕТСЯ из статус-файлов (`queued` → снова в очередь; `running` → interrupted,
перезапуск из бейджа топбара). Воркеров — `COCKPIT_ANALYSIS_CONCURRENCY` (дефолт 2);
git-refresh перед оценкой — не чаще раза в 10 мин (волна задач не дёргает pull каждый раз).
Одна оценка ~5–15 мин: очередь в 70 задач — это часы, «висит» ≠ сломано (смотри /api/analysis).

**Агенты и промпты (модель данных):** агент в `agents/` — переиспользуемый ШАБЛОН роли
(один id = один шаблон, коллизий и суффиксов `-<профиль>` больше нет, `.remap.json` умер).
Шаблон советует `tier` (КЛАСС модели: `reasoning|balanced|cheap`) и `effort`, но runtime их не
читает: исполняемая model policy остаётся в `profiles/<name>/runners.env`. Класс, а не семейство —
потому что база агентов общая, а проекты могут жить на разных исполнителях: «opus» в общем
шаблоне нечем сверять с профилем другого провайдера. Соответствие
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

**Раздел «Карта задачи» в промпте разведки — контракт с движком, а не стиль.** Шаблон
`server/seed/agents/scout.md` (и соответствующие сайдкары профилей) требует от SCOUT раздел
ровно с этим заголовком: движок достаёт его из `recon.md` и вклеивает в промпт каждого
следующего этапа, чтобы те не выясняли поиском, где что лежит (около пятой части всех
раундов маршрута). Правки семени **не догоняют уже установленное**: `installAgents` пишет
create-only, а сайдкар маршрута — инстанцированная копия, и до прогонов текст доезжает
только публикацией нового каталога (`routes/publish.mjs`) и только на НОВОЙ попытке
(ни `resume`, ни `goto` каталог не перечитывают). Формат и потолок 16 КБ описаны в
[ENGINE.md](../engine/ENGINE.md).

**Прогоны в UI:** адаптер читает единственный runtime root `config.stateDir`.
Полностью закреплённая route-attempt identity делает реестр исполняемым; исторические
реестры без неё остаются видимыми только для чтения. Поля `generation`, веток запуска
v1/v2 и compatibility resume нет. Слепой форс этапа получает 409
`engine_owned_state`, повторный launch — `run_exists`: immutable-журнал подделывать нельзя.
`GET /api/tasks` дополняет карточку полем `title` из сохранённого валидного тикета:
это основной fallback для ручных запусков без Bitrix и мгновенный заголовок до ответа
портала. Живое название B24 имеет приоритет и только оно открывает B24-модалку; полный
`description` тикета в список не попадает, чтобы не раздувать периодический ответ.

**Каталог маршрутов закрепляется под task lock движка.** Форма запуска присылает
`expectedCatalogHash`, HTTP-preflight и `factory check` остаются быстрым fail-fast, а
авторитетная сверка происходит один раз внутри создания попытки: прочитанный там же hash
становится пином attempt/pins. Публикация нового каталога между открытием формы и стартом
даёт типизированный `catalog_changed` без attempt, registry и занятых ресурсов.

| Действие | Кто делает | Как |
|---|---|---|
| Ворота (approve/reject) | движок | мост в `factory gate --attempt … --commit-only` |
| «Перейти сюда» | движок | `factory goto` пишет событие human-rewind с причиной |
| Runner switch | движок | тот же multi-runner и exact active run |
| Lifecycle isolated-стенда | **кокпит** | только для `WORKSPACE_MODE=isolated` |
| Lifecycle shared-стенда | внешний владелец | Cockpit и engine не создают, не сносят и не перезапускают его |
| Продолжить упавший прогон | человек кнопкой | `POST /api/tasks/:id/resume` (resume ТОЙ ЖЕ попытки) |

Терминальность прогона несёт trusted attempt-ledger и его `RESULT`
(`completed|abandoned|recovered|human-rewind`), а не `WF_STATUS`: последний —
только вторичная проекция активности и не является terminal marker. На этом же
trusted поле стоит кнопка «Продолжить»: без него закрытая
попытка выглядела бы упавшей. Автовосстановление отключено: resume всегда является
явным действием человека и требует exact attempt.

**Маршруты:** `/api/routes` — единственный namespace immutable route bundles.
Хранилище опубликованных бандлов — `~/.factory/routes` (`config.routesDir`); движок
`factory` читает тот же каталог по умолчанию. Legacy CRUD, reseed и API alias удалены.
Route/catalog публикуются полным immutable bundle, exact bytes перечислены в manifest,
а `current.json` меняется через compare-and-swap. Catalog pin включает bootstrap Scout и
точные route hashes. Server валидирует schema при публикации и чтении; engine перед
исполнением делает независимую повторную проверку. Route schema описывает executor,
phase, policy, status owner, retry и все переходы, но запрещает `model`, `provider`,
`effort` и произвольный shell.

Граф в UI строится из **закреплённой машины попытки**, а не из live `graph.json`:
main/tail задают узлы, rewind — красные рёбра, штатный `skipped` без `stop` — optional.
Маршрут без канонического `ship` законен и отображается без публикационного хвоста; engine
передаёт ему `delivery.mode=disabled` и не создаёт actions/targets. Publish-маршруты
профиля с `task-comment` в хуке `profile_delivery_actions` кокпит запускает с
`--task-comment`: узел `ship` оставляет во внешней задаче комментарий со ссылками
на PR (см. [b24.md](b24.md)). Тексты одинаково
названных ворот ключуются парой `route/node`, поэтому `gate_accept` поискового маршрута не
называется браузерной приёмкой изменения.

Pin защищает только bundle (machine + prompts). `engine` и `profile.sh` читаются живыми,
`runners.env` — при routing decision, а `server`/`web` меняются после человеческого
рестарта/развёртывания. Поэтому rollout сначала ставит обратно совместимые live-компоненты,
затем CAS-публикует новый catalog; уже начатые попытки не перепривязываются.

**UI-слой:** `web/src/ui.ts` — единственная публичная точка импорта для product consumers.
Нативными form controls владеют только `web/src/components/primitives/`, overlays проходят
через общие `UiTooltip`/`UiPopover`/`UiDialog`, а reusable skin подключается единым графом
`web/src/styles/index.css`. Системный `confirm()` запрещён: простой вопрос вызывает
`await confirmDialog(text, { danger, okText })` из public facade и показывает `UiDialogHost`.
Отдельный `web/ui-gallery.html` не входит в production build и служит auth-free browser
fixture. `npm --prefix web run test:ui-browser` поднимает его через Vite и настоящим Chrome
проверяет ширины 340–1500 px, peer-геометрию 36/9, overflow, disclosure, overlays, Escape
и возврат фокуса; Chrome запускается с отдельным временным profile.
Тултип исполнителя
в топбаре показывает потребление лимитов подписки (`/api/providers/usage` →
`executor.usage()`: у Claude — OAuth-ручка usage хостового CLI, у Codex — read-only
`account/rateLimits/read` официального `codex app-server`; кэш 60с). Запрос Codex не создаёт
ход и не вызывает модель. Ответ всегда структурирован: бары не исчезают при временной ошибке,
а помечаются устаревшими; 401/403, 429, отсутствие авторизации и отсутствие usage API имеют
отдельные сообщения и действия. Баланс, платное продолжение и заработанные сбросы описываются
provider-neutral массивом `resources`; его `toggle`/`number`/`button`/`link` контролы рисует
общий компонент. Полосы группируются полем `group`: линия во всплывашке появляется на границе
ведра лимитов, а стабильный порядок обязан обеспечить адаптер — у Codex сервис перетасовывает
ключи вёдер на каждый ответ. Ведро, которого раньше не было, помечается «новое» по серверному
`provider-usage-seen.json`; первое наблюдение исполнителя — базовая линия, иначе новыми стали бы
сразу все ([детали](chat-agents.md#модульное-подключение-нового-ии)).
Мутации идут через
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
**Арбитр типизированной остановки** (`lib/factory-arbiter.js`, `POST /api/tasks/:id/arbitrate`)
снимает тупик вместо человека. Движок останавливает маршрут fail-closed, когда автоматический
возврат перестал давать прогресс, — остановка правильная, но человек в этот момент делает
работу курьера: собирает оба вердикта дуги, читает артефакты, формулирует указание и
возвращает курсор. Замер по журналам всех попыток: 28 типизированных остановок, медиана
ожидания 15 минут, сумма 59.7 часа, максимум 13.9 часа; пять ночных стоянок дают 53 часа
из этих 60.

Арбитр повторяет ровно этот путь и получает то, чего человеку не хватает, — **доступ к
коду**: он идёт обычным `executor.run` в рабочем дереве задачи в режиме `plan` с каталогом
состояния в `extraDirs`, поэтому проверяет спорное утверждение по коду, а не рассуждением
о нём. Это не `runUntrusted`: недоверенного внешнего ввода здесь нет, вход — сам проект и
вердикты его же узлов.

**Что арбитр может, названо по замеру.** Режим `plan` даёт чтение, поиск и обход файлов и
НЕ даёт запуск команд (проверено живым `claude -p`). Для разобранного случая этого хватает:
вопрос «есть ли между модулями общий импорт» решается поиском. Но опыт запуском арбитру
недоступен, и промпт говорит ему об этом прямо: вопрос, который без запуска не решается, —
законный повод отдать решение человеку. Чтобы дать арбитру запуск, нужен канал прав в
контракте `executor.run` (туда сейчас уезжает только `fastMode`) — отдельная работа.

Границы проверяются до побочного действия и названы человеку словами:

- разбирается ТОЛЬКО `no-progress`. `human` (упал стенд, не хватило прав) — прямой вызов
  человека, решение оттуда из вердиктов дуги не выводится;
- **границу задачи арбитр менять не вправе.** Снять критерий приёмки, отказаться от
  проверки, выбрать приоритет между несравнимыми вариантами — это `verdict: "human"`, и
  карточка уезжает человеку без возврата курсора. Признака два: объявленный самим арбитром
  `scope_change` и вердикт;
- потолок арбитражей на попытку (`ARBITER_MAX_PER_ATTEMPT`), потому что возврат арбитра,
  как и человеческий, обнуляет замкнутый набор дуги;
- решение уезжает `factory goto --actor cockpit-arbiter`, то есть в журнале попытки оно
  отличимо от человеческого (см. [ENGINE.md](../engine/ENGINE.md));
- ответ модели разбирается строго: пустое поле карточки или пустое указание означают, что
  решения нет. Пустое задание узлу при записи «решение принято и обосновано» запрещено.

Гейт кнопки в UI читает МАШИННЫЙ вид остановки — `stall.stop` (`lib/stall.js`), а не
заголовок: заголовок пишется человеку и меняется вместе с формулировками движка.

**Зовут арбитра двое, и тело у них одно** (`fastify.factoryArbitrate`): кнопка «разобрать
и продолжить» в плашке затыка и автоматический вотчер `lib/factory-arbiter-watch.js`.
Вторая копия границ разошлась бы с первой, поэтому у автоматического пути нет ни своей
проверки вида остановки, ни своего потолка арбитражей.

Вотчер своего опроса состояния не заводит: он просыпается по той же шине `state-change`,
что и окна, ждёт минуту тишины (остановка — состояние, а не мгновение) и держит редкую
15-минутную страховку на случай потерянного события. За обход разбирается ОДНА задача:
арбитраж занимает минуты живого агента, и две параллельных попытки спорили бы за
исполнителя. Задача, которую не удалось разобрать, уходит в часовой cooldown — иначе
детерминированный отказ (нет модели, нет рабочего дерева) крутился бы на каждом событии.

Настройка — prefs `arbiter: {modelRef, effort, auto}`, карточка «Настройки → Запуски →
Арбитр остановок». **`auto` выключен по умолчанию**: арбитр действует сам, двигая курсор
чужой задачи, и включённым по умолчанию делал бы это там, где его решений ещё никто не
читал. Кнопка при этом работает всегда — тумблер решает только вопрос «сам или по нажатию».
Ночные стоянки снимает именно автоматический путь: медиана ожидания человека 15 минут, но
53 часа из 60 дают пять стоянок по 8–14 часов, когда кнопку нажать некому.

- Автовосстановления незакрытых прогонов НЕТ: после запуска Cockpit никто не перезапускает
  погибший демон, `resume` остаётся явным действием человека и требует exact attempt.
  Прежние тумблер, эндпоинт `/api/factory/recovery` и чистый решатель удалены — они
  описывали поведение, которого в runtime не было, и решали по provider-writable
  `.pipeline`. Условия возврата автоматики — локальный черновик
  `docs/plans/pipeline-autonomy-plan.md`.

## Веб (`web/src/`)

- `views/`: Board (доска B24), Pipeline (конвейер + модалка этапа), Agents (база агентов-стадий),
  Chats (телеграм-раскладка чатов), Routes (редактор маршрутов + живой превью),
  Projects, Code (дерево/файл/git), Shelf (полка задач), Documents (скрытый route просмотра MD/TXT),
  Diff (Monaco), Tools (агрегатор), Video, Terminal,
  Settings (Приложение — включая карточку голосового компаньона / Речь / Битрикс24 /
  Исполнители / Запуски / Плагины / Сервер / Доступ), Login
  и TaskModal. Глобальный `features/companion/CompanionHost.vue` — компактная chat surface;
  полный `ChatSession` монтируется только в `ChatsView`.
- **Code, Shelf и Terminal монтирует только постоянный `shared/layout/ToolHost.vue`.**
  Route-компоненты `/code`, `/shelf` и `/terminal` — пустые адаптеры; `page`, `dock` и
  `hidden` меняют CSS одного render-site.
  Поэтому во вкладке бывает максимум один Monaco и один terminal WebSocket. Компоненты загружаются
  независимо через `shared/tools/registry.js`, а `stores/dock.js` держит динамические mounted-флаги,
  runtime и exact-once intent-очереди. Правая рейка и overlay-док существуют с 900 px; на
  760–899 px остаются компактный sidebar и route-страницы, до 759 px — нижняя навигация.
  Переключатель desktop-sidebar закреплён снизу, а изменение его ширины анимируется без
  резкого layout-скачка (с отключением через `prefers-reduced-motion`).
  У overlay-дока нет отдельной дублирующей шапки: expand/close встроены поверх строки
  панели. «Во весь экран» не меняет route/history, а растягивает тот же dock
  render-site на всю ширину content-колонки; повторный клик возвращает сохранённую обычную
  ширину. Выбор геометрии хранится в `cockpit-dock-expanded` и восстанавливается после
  скрытия/повторного открытия и при первом явном открытии после reload; сам док после
  загрузки не показывается. У скрытого дока активный `isExpanded` остаётся
  выключен, поэтому основной контент не блокируется. Перекрытый `<main>` на это время
  получает `inert`/`aria-hidden`, а переход в
  другой раздел сворачивает expanded до обычного дока, чтобы новая страница сразу была
  видна. В compact Code дерево остаётся слева от Monaco и меняет ширину вертикальным
  разделителем; его фактический viewport-max (42%, 140–420 px) совпадает с JS/ARIA.
  Повторная активация Code перечитывает project/repo/tree/file по схеме
  stale-while-revalidate: прежние дерево и Monaco-модель остаются видимыми до атомарной
  подмены свежим снимком, а очищаются только после подтверждения, что выбор исчез.
  До загрузки lazy chunk и первого API-снимка показывается лёгкий `CodePanelLoading` той
  же геометрии; он не импортирует и не создаёт Monaco.
  В compact-шапке текстовая кнопка «Дерево» и icon actions дока используют один размер
  30 px: central `data-context="tool-dock-navigator"` задаёт одновременно `height` и
  `min-height`. Одного `height` недостаточно — базовый `UiButton` сохраняет минимум 36 px.
  Односторонний diff добавленного/удалённого файла автоматически занимает одну колонку,
  не оставляя заведомо пустую половину редактора.
  В `TaskModal` метаданные триажа оборачиваются отдельно от action, поэтому чипы могут
  переноситься, не сталкивая «Переоценить» вниз; все footer-actions имеют единый размер
  36 px через `data-context="task-footer-action"`. Там же человек может частично изменить
  заголовок, описание, исполнителя, проект и приоритет B24-задачи; свежий ответ заменяет
  кеш `stores/tasks`, а доска перечитывается. Служебные actions во всплывашках
  topbar компактнее обычной формы: 28 px внутри секции и 30 px у нижнего перехода.
  Внешние provider-resource links сохраняют вид компактной подчёркнутой ссылки и переносят
  длинный текст внутри popover через `data-context="topbar-popover-resource-link"`.
  **Боковая панель «Кода» — только содержимое.** Проект и рабочая копия выбираются в шапке
  раздела боксless-селектами (тот же приём, что в строке состояния чата). Оба видны ВСЕГДА,
  даже когда вариант один: селект, спрятанный за отсутствием выбора, читается как пропавшая
  возможность — «куда делось переключение проекта». Сжимается сначала рабочая копия (у неё
  есть подсказка с полным путём), а container query `code-head` до 620 px убирает подписи
  контролов: в доке они стоили проекту его имени («rd…»). Замер дока: над первым файлом было
  258 px служебной высоты из 780 px панели, стало 138 px, а на вкладке файлов — 6 px вместо
  141 px. Композер коммита имеет свой ритм 30 px (`data-context='code-commit'`, все четыре
  контрола одной высоты) — общая высота формы в 36 px рядом со строками в 25 px читалась
  огромными кнопками. Само поле — `UiTextarea` с компактным скином: сообщение бывает
  многострочным, поэтому пустое поле ростом в строку (30 px) растёт по набору до четырёх
  (84 px), Enter переводит строку, а коммит уходит по `Ctrl/Cmd+Enter`. Служебные кнопки списка — 26 px у строки и 24 px у заголовка группы,
  строка дерева — 25 px; вид строки живёт в общем скине
  `.ui-pressable[data-context='code-tree-row']`, а не в локальных стилях плагина.
  **Кнопка индексации СТРОКИ на указателе всплывает поверх строки** по наведению
  (`data-context='code-row-action'` + `data-ui-row='code-change'`), уступая имени файла
  постоянную колонку в 30 px; на тач-устройстве (`hover: none`) она остаётся в потоке.
  Container query `code-panel` при ширине панели до 250 px убирает счётчик `+N −N` и хвост
  каталога: имя файла — то, ради чего список открывают, числа видны в самом дифе, а полный
  путь остаётся в подсказке строки. Измеряется панель, а не окно: ширину ей задаёт
  разделитель дерева. Итог замера в доке 218 px: имя файла выросло с 63 px до 116 px.
  **Изменения показаны группами «В индексе» и «В рабочем дереве»** (`buildGitGroups`), как
  Source Control в VS Code. Пустая группа не рисуется, поэтому при чистом индексе панель
  остаётся прежним списком «Не в коммите», а заголовок второй группы меняется только когда
  индекс не пуст: пока делить нечего, «не в коммите» точнее. Один путь законно лежит в обеих
  группах с РАЗНЫМИ сторонами дифа, поэтому и выбор файла, и раскрытие каталога адресуются
  парой `группа:путь` (`gitRef`) — иначе клик по файлу в индексе выбирал бы одноимённый файл
  рабочего дерева. Чей это диф, шапка редактора называет только при двух группах.
  **`+/-` владеют составом индекса:** действие доступно у строки и у заголовка группы;
  переименование передаёт Git оба пути. `commit` никогда не делает скрытый `git add`, поэтому
  рабочая правка поверх частично staged-файла остаётся после коммита. Первый push ветки без
  upstream выбирает `pushRemote`/`remote.pushDefault`/branch remote/`origin`/единственный remote
  в этом порядке, выполняет `--set-upstream`, следующие — обычный `git push`; detached HEAD
  отклоняется словами. Мутации одного worktree сериализованы сервером, чтобы два окна не
  сталкивались через случайный `index.lock`.
  **Название коммита генерируется только по staged snapshot:** кнопка отправляет ограниченный
  diff и темы нескольких свежих коммитов выбранной в `pluginSettings.code.commitMessageModel`
  модели. Репозиторий считается недоверенным вводом, поэтому разрешён только `runUntrusted`
  без инструментов/cwd/MCP/сессии; модель и effort сверяются с живым реестром перед ходом.
  Ответ лишь заполняет редактируемое поле — commit остаётся отдельным явным нажатием человека.
  Поле ввода занимает свою строку композера, кнопки — свою (иначе в доке поле схлопывалось
  до двух символов), а тонкая строка под ними говорит только то, чего нет в шапке: связь с
  remote при расхождении, `detached HEAD` и случай, когда живая ветка разошлась с той, что
  отдал каталог рабочих копий. Совпавшая с remote ветка новостью не является и строки не даёт.
  **Плоский список изменений делит путь** (`splitGitPath`): имя файла целиком, каталог —
  приглушённым хвостом, который сжимается первым (вес 999 против 1) и обрезается слева.
  Целый путь обрезался с конца, то есть съедал именно имя.
  **Лесенка дерева: шаг живёт в CSS (`--tree-step`), скрипт присылает строке только
  `--depth`.** Место под шеврон занято и у файла (пустой `.chev`): без него имя файла уезжало
  влево на ширину стрелки и вставало вровень с каталогом уровнем ВЫШЕ — замер показывал
  файл 2-го уровня на 34 px против каталога 1-го уровня на 40 px, то есть лесенка была
  инвертирована. Направляющие предков рисует `background-image` строки, поэтому наведение и
  выделение меняют только `background-color`: shorthand `background` стёр бы линии.
  **Растровая картинка показывается предпросмотром вместо Monaco**: `<img>` тянет байты из
  `/api/code/:project/raw`, редактор под ней не создаётся вовсе, а пометка «бинарный»
  заменяется на «изображение» — у файла, который есть чем показать, она была ложной
  тревогой. Сорванная загрузка объясняется словами (размер, формат), а не пустым местом.
  **Intent `open-file`** (из чата, deep-link `#/code?project&repo&root&path[&line]` или
  `openCode`) адресует репозиторий и КОРЕНЬ дерева, а не «текущий выбор»: панель сама
  переключает рабочую копию, раскрывает каталоги пути (дерево ленивое — иначе файл
  открылся бы в редакторе, но потерялся бы в навигаторе) и встаёт на строку. Недоступный
  проект, исчезнувшая рабочая копия и пропавший файл называются в плашке ошибки поимённо.
  Переход 900→899 закрывает док и размонтирует непоказанные панели, чтобы возврат на широкий
  экран сам не создал PTY.
- **Escape координирует единый typed stack.** Consumers регистрируют semantic layer через
  `useUiLayer` из `web/src/ui.ts`; числовые приоритеты остаются private в
  `services/layers/priorities.ts`. Dock, tools-popover, модалки, confirm и popover закрываются
  по одному: одно нажатие действует только на верхний слой.
  Monaco/xterm помечают собственного владельца Escape и не отдают локальную клавишу стеку.
- `PipelineView` численно сопоставляет `task` карточки с `id` из `board.data.tasks` и отдельно
  от времени работы узлов показывает состояние B24-таймера. Идущий таймер дотикивается через
  `liveTimerSec(task, now)` общим секундным тиком страницы. Источник — уже загруженный снимок
  `GET /api/b24/dashboard` с `timerRunning`/`timerStartedAt`: отдельного запроса и нового
  polling нет, а для отсутствующей в снимке задачи статус не показывается.
- `views/pipeline/FactoryGraph.vue` — SVG-граф; геометрия/кривые в `shared/graph-geom.js`
  (порт `node_geom`/`edge_path`); автораскладка маршрутов — `shared/route-layout.js`.
- `TaskModal` pin-ит в запуске тот catalog hash, который показал человеку: между
  открытием формы и стартом профиль мог опубликовать новый каталог.
- `stores/`: `board` (кеш доски + поллинг), `tasks` (кеш деталей + действия), `system`, `ui`
  (модалка задачи), `pwa` (обновление/установка и Screen Wake Lock текущего устройства),
  `chat` (мультисессии, история на сервере), `companion` (только состояние компактной
  поверхности и связывание headless bridge/STT/TTS),
  `analysis`, `auth`, `diff`, `dock`, `plugins`, `providers` (реестр исполнителей),
  `video-session` (сеанс разбора встречи: части и их job'ы, черновики задач, фоновый
  поллинг распознавания и тонкий снимок в localStorage — раздел «Видео» это только его
  отображение, см. [video.md](video.md)),
  `inbox` (общий счётчик новых обращений: initial read + SSE + минутный poll),
  `task-favorites`, `task-shelf` и `task-seen` (личное состояние задач B24,
  server-confirmed снимок с revision),
  `ui-context` (owner-scoped bounded prompt context и отдельный trusted `routingScope`),
  `notify-watch` (что на конвейере встало на человеке и готовая наблюдаемая проекция для полки).
- **Личное состояние задач B24 живёт на сервере, а не в браузере** (`task-favorites`,
  `task-shelf`, `task-seen`; контракт и инвариант базовой линии —
  [b24.md](b24.md#личное-состояние-задач-избранное-полка-и-просмотренное)).
  Эти account-scoped stores хранят снимок аккаунта (`scope`/`revision`) и применяют ответ, только если
  он свежее: у поздних ответов и у смены аккаунта портала иначе получалось воскрешение
  чужих отметок. Базовую линию просмотра ставит ровно одно место — `board.load()` после
  первого ответа портала; открытие карточки (`TaskModal`) гасит метку «новая» у одной
  задачи. `App.vue` поднимает общие lifecycle полки/просмотренного после входа и чистит
  личные снимки при потере сессии.
- **Полка не является фильтром доски и не связана с избранным.** Её `entries` остаются
  durable до явного DELETE, а `rows` строятся единственной чистой функцией
  `shared/task-shelf.js` из снимка записи и уже загруженных `analysis`, `notify-watch`,
  `board`. Источник без успешного снимка даёт неизвестность, а не событие. Первый
  сопоставимый снимок каждого источника зажигает накопленное состояние молча; оповещение
  через `shared/notify.js` уходит только на следующий переход neutral → lit. Открытие
  `TaskModal` делает PUT с `createIfMissing:false`: пересобирает снимок и не воскрешает
  запись, уже удалённую в другом окне. `task-shelf-changed` идёт через singleton SSE и
  означает только «перечитай полный снимок».
- **Фильтры доски адаптируются по ширине самой карточки, а не viewport.** Sidebar, dock и
  правая колонка оставляют `BoardView.primary` заметно уже окна, поэтому viewport-breakpoint
  уже приводил к наложению тулбара на «Ждут моего контроля» в landscape-планшете. Колонки
  доски переносятся intrinsic-flex-раскладкой, а `board-primary` container query сворачивает
  фильтры в кнопку на узкой карточке; поиск остаётся видимым всегда. «Избранные» и «Новые» —
  независимые фильтры, режим триажа — один enum `all|unrated|needs-info`, сортировка и режим
  сохраняются в прежнем ключе `board.triage`. Массовая оценка остаётся в сворачиваемой панели,
  но отделена от переключателей как акцентное действие; она относится ко всем задачам без
  оценки на доске, а не только к видимой выборке. Поиск, select, фильтры и действия имеют
  одну высоту из глобального токена `--control-height`: адаптив переносит или сворачивает
  всю группу, но не меняет размеры её отдельных контролов.
- **Screen Wake Lock** — локальная настройка `cockpit-screen-wake-lock` во вкладке
  «Настройки → Приложение». Она не хранится в серверных prefs, чтобы планшет не менял
  энергоповедение остальных окон. `stores/pwa.js` держит блокировку на уровне всего SPA,
  а после системного освобождения в фоне повторяет запрос по `visibilitychange`.
- **Пропорции страницы «Чаты» — тоже настройка устройства**: ширина списка чатов
  (`cockpit-chats-list-width`) и высота поля ввода (`cockpit-chat-composer-h`) двигаются
  разделителями и живут в localStorage — рядом с шириной дока и
  дерева «Кода», по той же причине: серверные prefs навязали бы планшету раскладку монитора.
  Пустая настройка означает «решает CSS»; правила и границы — [чат с агентами](chat-agents.md).
- **Чипы «требует меня» в навигации** (`AppShell.vue`, карта `badges`: пункт → `{n, kind, title}`) —
  одно правило на все разделы. Жёлтый пульсирующий (`wait`) — работа СТОИТ, пока не подойду
  (вопрос агента в чате, ворота конвейера); красный (`stall`) — конвейер упёрся или оборвался,
  своей кнопки там нет, надо разбираться; синий — просто непрочитанное. Видны и в свёрнутом
  сайдбаре, и в нижней навигации на мобиле; подсказка перечисляет задачи поимённо.
  При агрегации нескольких источников приоритет фиксирован: `stall > wait > info`.
  Источники: чаты — `chat.waitingCount`/`unreadCount`
  (см. [чат с агентами](chat-agents.md)), конвейер —
  `notify-watch` (он и так обходит `/api/tasks` + `/api/tasks/:id/graph` ради оповещений —
  второго обхода ради цифры не заводим; обновляется по SSE `state-change` + 120-секундная
  страховка), Inbox — `GET /api/inbox/summary` + singleton SSE `inbox-changed` + минутный
  poll для созревания Telegram-связок после окна тишины. Цифра конвейера — ЗАДАЧИ,
  а не поводы: задача, которая и ждёт у ворот, и числится вставшей, считается один раз.
- **Звонят все три беды вотчера, а не две.** Ворота, молчание и авария зовут человека
  через `shared/notify.js` по одному правилу: только НА ПЕРЕХОДЕ и только при непервом
  снимке — иначе каждый заход в кокпит оповещал бы о давно лежащих задачах. Ключ права
  на звонок у аварии — `задача:вид:этап`, поэтому другой узел, вставший так же, звонит
  отдельно, а один и тот же — один раз до явного действия человека. Авария молчала до
  27.08.2026: её считал чип и показывал тултип, но прогон, погибший на глазах (выключили
  машину, оборвался демон), не сообщал о себе ничем. Сторож —
  `tests/web/notify-watch-stall.test.js`.
- `shared/pipeline-wait.js` — единственный ответ на «чего конвейер ждёт от человека»
  (`waitingReason` + расшифровки ворот `GATE_REASON`). Общий для страницы конвейера, вотчера
  оповещений и чипа: цифра чипа обязана сходиться с «⏳ ждут тебя» на странице. Копий этой
  логики было две, и они уже разошлись в мелочах.
- `shared/agent-activity.js` — то же для «что сейчас делает агент»: `agentActivityLabel`
  (плашка активности) и `silenceReason` — ход, который идёт, но молчит дольше порога.
  Молчание — **третья** беда в `notify-watch` рядом с «ждут решения» и «встали»: конвейер
  формально работает, кнопки нет, и без звонка висяк виден только по сгоревшему лимиту
  этапа. Порог общий, из настроек (`runSilenceWindow`), приезжает вместе со списком задач;
  почему свежесть журнала на этот вопрос не отвечает и почему кокпит ничего не глушит —
  [грабли](gotchas.md).

## Граница B24

Доска и действия используют локальный `B24Client`, медиа — локальный pipeline, вход в
фабрику — `engine/bin/factory`, CLI — `bin/b24`. Резервный
Python-dashboard тоже использует Cockpit `B24Client` и хранилище кредов, но держит отдельный
cookie jar, чтобы два процесса не перезаписывали один файл. Прямых путей к внешнему checkout
в рабочем коде нет; внешние host hooks/settings/containers находятся вне репозитория.
Полный контракт авторизации, HTTP и мутаций — в [b24.md](b24.md).

## Плагины кокпита

Плагин = отключаемый блок: ссылка в одной из групп навигации, плашка
в «Настройки → Плагины», свои API/настройки. `nav.group` принимает `rail`, `tools` или
`dock`, отсутствующее/невалидное значение нормализуется в `rail`; `nav.order` задаёт
порядок внутри группы. При разнесённом rollout новый web восстанавливает group/order
старых серверных manifest только для известных встроенных `system: true` плагинов;
пользовательский legacy-manifest остаётся в `rail`. Реестр: `lib/plugins-registry.js` (SYSTEM =
video, code, shelf, inbox, telegram, github) + скан пользовательских `plugins/<id>/plugin.json` (+опц. `server.js`, роуты
в ЖЁСТКОМ префиксе `/api/ext/<id>/` (механика Fastify, перекрыть системное нельзя), контракт версионирован полем `api` (=1), регистрация на старте — вкл/выкл требует рестарта, у системных нет).
Состояние — prefs (`plugins`, `pluginSettings`). Модуль `modules/plugins/` декорирует
`fastify.pluginEnabled(id)` / `fastify.pluginSettings(id)` — регистрируется ДО модулей-плагинов;
системные модули (media, code, task-shelf, inbox, telegram, github) гейтят каждый роут живой проверкой (тумблер без рестарта → 404
plugin_disabled). Диктовка чата (`/api/chat/transcribe`) НЕ входит в плагин video — не гейтится.

**Умолчание вкл/выкл объявляет манифест, а не сорт плагина.** `isEnabled(prefsData, manifest)`
берёт явный выбор человека из prefs, иначе — `manifest.defaultEnabled ?? !!manifest.system`.
Признак `system` тоже живёт в манифесте (в `SYSTEM` и в скане), `modules/plugins` его больше
не дописывает: вторая копия правды разошлась бы с первой. Inbox включён по умолчанию;
Telegram и GitHub системные, но выключены: их страницы просят provider credentials и не
должны появляться сами у каждой установки.

Серверный manifest отвечает только за размещение ссылки. Встроить Vue-компонент в правый
док может лишь явная запись клиентского `shared/tools/registry.js`: произвольный user plugin
не получает frontend runtime одним JSON-полем. Фронт: `stores/plugins.js`, VideoView,
InboxView, TelegramView, GitHubView и `ToolHost` для Code/Shelf показывают заглушку при выключенном плагине
(по `plugins.loaded && !plugins.enabled(id)`, а `404 plugin_disabled` от сервера в этом
случае НЕ показывается красной плашкой — это состояние, а не поломка). Выключение Code
размонтирует Monaco, выключение Shelf скрывает строки/чип, но не удаляет entries; прямые
`/code` и `/shelf` остаются под понятной заглушкой.
Вкладка «Настройки → Плагины»: карточки горизонтальной сеткой (auto-fill 340px), селекты
настроек — стилизованные (appearance:none + свой шеврон), НЕ нативные. Все подтверждения
действий (снос стенда, форс этапа) — через confirmDialog, системный confirm() запрещён.

**Настройка типа `model`** (их три и они независимы: `triageModel` плагина Inbox,
`triageModel` плагина video — см. [video.md](video.md) — и `commitMessageModel` плагина Code)
хранит объект
`{provider, model, effort?}`, а варианты берёт из живого реестра `/api/providers` —
`optgroup` по исполнителям, как в чате. Строкой `<provider>:<model>` живёт только
значение `<option>`: у локальных исполнителей id модели сам бывает со слэшами и
двоеточиями, и разобрать склейку обратно нечем. Вендор в манифест не зашивается:
модель у каждого своя, а зовётся она общим путём (`resolveModelRef` → адаптер; конкретный
сценарий выбирает безопасный transport — для Inbox, video и Code это `runUntrusted`).
Выбор, пропавший из реестра (сняли CLI, переименовали модель), показывается отдельным
пунктом «— нет в реестре»: молча показать «не выбрана» нельзя — в настройках он остался,
и сервер всё ещё ходит именно ей.

**Усилие — отдельный контрол рядом, а не вариант в списке моделей**: одна и та же модель
работает и быстро, и вдумчиво. Лестницу объявляет сама модель (`model.efforts`), пустая
означает «уровень передать нечем» — контрола нет вовсе, как слайдера в чате. Пустой выбор
значит умолчание исполнителя и уезжает ОТСУТСТВИЕМ ключа, а не пустой строкой. Уровень
сверяется с реестром перед каждым ходом (`resolveInboxTriageTarget` используется и
model-only генератором Code): настройка живёт
долго, а `--effort xhigh` у модели без такой ступени не игнорируется, а роняет запуск CLI.
Устаревший уровень снимается с записью в журнал и остаётся видимым в настройках с
пометкой «нет у этой модели».

## Демо: удалено целиком

Съёмки демо в кокпите БОЛЬШЕ НЕТ: видео вынесено в отдельный сервис. Удалены плагин «Демо»
с `/api/demo*` и `DemoView`, отдача `/demo/*` из статики и
`PROTECTED_STATIC`, режим `factory <TASK> demo` в движке, промпт DEMO с лимитами и скриптами
озвучки в профиле, шаблон агента и сами ролики (`~/.factory/state/demo`).

Что осталось от истории и почему это не надо «возвращать обратно»:

- До этого демо убрали из ЦЕПОЧКИ (хвост bin/factory: ship → сразу ретро) вместе
  с воротами `DEMO_ASK`/`GATE_DEMO` — из `--init` реестра, из `ROUTE_STAGES.feature`, из
  каталога стадий `lib/stages.js`, из `GATE_REASON` и из эндпоинта ворот (он принимает только
  `GATE_*`). Пока они числились этапами маршрута, прогресс feature не доходил до 100%,
  а дашборд ждал ответа на вопрос, которого движок больше не задаёт.
- Ключ `DEMO` в старых реестрах мёртв: его никто не пишет и не ждёт. Исторический
  реестр доступен только для чтения; единый route runtime не строит по нему маршрут
  и не возобновляет такую попытку.
- Распознавание видео в задачи (плагин «Видео», `/api/media*`) к демо отношения не имеет
  и осталось на месте.

## Авторизация и CLI-токен

Весь `/api` за сессией (httpOnly cookie). Для локальных CLI (bin/b24, ship-этап фабрики,
скиллы) — `server/.state/cli-token` (0600, создаётся сервером): заголовок `X-Cockpit-Token`.
`bin/b24` сам читает токен от РЕАЛЬНОГО пути скрипта (readlink -f, симлинк из ~/.local/bin).
Внутренний `internalToken` (in-memory, per-process) — для permission-mcp чата.

## Авто-шип фабрики

SHIP-этап публикует по правилам выбранного профиля: чистка диффа → интеграция с базовой
веткой (конфликт → abort и отдельный PR) → тесты → коммит → push → создание или обновление
PR → комментарий в настроенный трекер → итог в `ship.md`. Конкретные команды и разрешения
принадлежат локальному профилю и не хардкодятся в Cockpit. Не запушил → SHIP failed.
