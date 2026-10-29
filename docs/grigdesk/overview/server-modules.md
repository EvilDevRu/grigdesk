# Модули сервера (server/src/modules/)

Относительные пути данных `chats/`, `plugins/`, `telegram/` и `github/` ниже
считаются от [папки данных](../server/data-home.md), а не от дерева кода.

| Модуль | Эндпоинты | Источник |
|--------|-----------|----------|
| `factory` | `/api/tasks*`, `/api/factory/{routes,stages,slots,runners}`, запуск (с выбором runner)/ворота/этапы/runner switch+override/стенд, `POST /api/tasks/:id/arbitrate` — арбитр типизированной остановки | `~/.factory/state` + `<factoryHome>/bin/factory` |
| `b24` | `/api/b24/{dashboard,task/:id,users,groups}`, мутации `/api/b24/{tasks,task/:id/*}` | `B24Client` (через очередь `_run`) |
| `task-favorites`, `task-shelf`, `task-seen` | `GET /api/b24/task-favorites` + `PUT/DELETE .../:taskId`, `GET/PUT/DELETE /api/b24/task-shelf[/:taskId]`, `GET/POST /api/b24/task-seen` | личное состояние человека (избранное, полка, «просмотрено») — отдельные schema-versioned файлы по opaque-scope аккаунта портала ([детали](../b24/personal-task-state.md)) |
| `system` | `/api/system`, `/api/system/server`, `POST /api/system/restart`, `GET/POST /api/system/web-rebuild` (пересборка web-бандла из рабочего дерева) | `/proc`, `os`, systemd/manual launcher |
| `media` | `/api/media/{doctor,upload,ingest,ingest/:jobId,extract-frame,plan-tasks,frame/:run/:file,clip,clip/:run/:file}` | общий `SpeechRuntime`, ffmpeg + локальный whisper; хранилище раздела — `lib/media/storage.ts` (запись кладётся по содержимому, уборка по возрасту, занятое место в `doctor`); разбор расшифровки на черновики задач — `runUntrusted` выбранной модели, кадр и фрагмент записи к задаче — декораторы `mediaFramePath`/`mediaClipPath`, байты фрагмента отдаются с Range ([детали](../media/README.md)) |
| `settings` | `/api/settings/{prefs,factory-debug,b24,speech*}` | prefs, speech capabilities/model jobs, engine debug CLI, `CredsStore` |
| `chat` | `/api/chat*`, `/api/tasks/:id/chat`, история/вложения/permission, `/api/chat/transcribe*` | выбранный executor + `chats/`; процесс исполнителя живёт между ходами (`lib/chat/liveSessions.ts`; список и гашение — `/api/chat/sessions`), непрошеный ход агента едет через `chats/pending`; browser/локальная диктовка использует тот же speech-контракт ([детали](../chat/README.md)) |
| `routes` | `GET/POST /api/profiles`, immutable `/api/routes/*` (current, revisions, catalog, route+graph, publish) | v2 bundles — `~/.factory/routes` (`GRIGDESK_ROUTES_DIR`); проекты GrigDesk — prefs |
| `providers` | `/api/providers*` (модели, usage/resources/actions, обновления CLI) | `lib/executors/*` + локальный реестр моделей |
| `analysis` | gated `/api/analysis*`, analyze/clarifications и ручной triage-arbiter | системный плагин, очередь и локальные файлы в `~/.factory/analysis` |
| `projects`, `code` | `/api/projects*`, `/api/code/{roots,:project/*}`: чтение дерева/дифа, stage/unstage, commit, push и генерация названия | профили/prefs + git/worktree + выбранный `runUntrusted` executor |
| `documents` | `/api/documents/{resolve,file}` | зарегистрированные read-only MD/TXT sources ([детали](../plugins/documents.md)) |
| `inbox` | `GET /api/inbox[/{summary,status}]`, `POST /api/inbox/channels/:channel/{activate,deactivate}`, решения `POST /api/inbox/items/:ref/{task,dismiss,reset}` | общий merge Telegram/GitHub, account-owned `inbox-state.json`, единый draft/triage/worker и B24 task service; provider credentials здесь отсутствуют |
| `telegram` | `GET /api/telegram/{status,chats}`, `GET/PUT /api/telegram/rules`, отдельный CAS `PUT /api/telegram/rules/agent-search`, `POST /api/telegram/{connect,recheck,disconnect,expand,service-chat}`, пульт `POST /api/telegram/pult{,/confirm,/disable}` + декоратор `telegramDiscussion` | Bot API (`getMe` + account-aware long polling), active token в private state; bindings и `accounts/<accountRef>/{state.json,archive/,rules.json,bot-settings.json,pult-state.json,inbox-state.json}` — `config.telegramDir` |
| `github` | `GET /api/github/status`, `GET/PUT /api/github/rules`, CAS `PUT /api/github/rules/agent-search`, `POST /api/github/{connect,recheck,disconnect,force-forget}`, public HMAC ingress `POST /hooks/github/:ingressRef` | GitHub REST + repository webhook `issues/opened`; PAT/secret в private state, bindings и `accounts/<accountRef>/{archive/,ingress-state.json,rules.json,inbox-state.json}` — `config.githubDir` |
| `plugins` | `/api/plugins*`, `/api/ext/<id>/*` | системный реестр + `plugins/<id>/` |
| `auth` | `/api/auth*` | учётная запись, сессии и CLI token |
| `terminal` | `/api/terminal` (WebSocket: `in`, `resize`) | stdlib Python helper: `pty.fork()`, `TIOCSWINSZ`/`SIGWINCH`, cleanup process group |
| `health` | `/api/health` | — |

Fastify-плагины: `auth` (весь `/api`, WebSocket и `/shots` закрыты сессией;
публичны state/login/setup, локальные CLI используют `X-GrigDesk-Token`), `sse`
(fs.watch → broadcast), `static` (web/dist, index=no-cache, assets=immutable).
Гард регистрируется до модулей. Сервер использует один HTTP-сокет на loopback;
[локальный доступ](../server/loopback-access.md) описывает cookie и настройки запуска.

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
собирает `lib/inbox/skipReason.ts`) и возможностью поставить задачу вручную через
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
storage и operator gates описаны в [inbox.md](../inbox/README.md).

**Телеграм-пульт** (`lib/telegram/pult/`) — живая картина конвейера и кнопки решений
в подтверждённой кодом личке владельца, тем же ботом и тем же поллером
(читатель getUpdates один; `callback_query` принимает общий цикл). Вотчер импортирует
те же `shared/pipeline/pipelineWait.ts` и `shared/pipeline/agentActivity.ts`, что чип навигации, слушает
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
ensure → CAS-сохранение обеих реплик → POST /api/chat без `dontAsk`/
`bypassPermissions`, неблокирующе для поллера; во время хода — только `typing`,
«Стоп» по chatKey после 30 с, итог одним сообщением; «Сжать»/«Сбросить память» —
через существующие `/api/chat/compact` и `/api/chat/session/reset`). Ход не переживает
перезапуск сервера: после старта marker сверяется с `/api/chat/active`. Мутаций две —
resume и пересборка стенда, обе вторым тапом с TTL. Постановка
задач принадлежит Входящим, запуск прогонов, деньги, goto, снос и закрытие — GrigDesk.
Полный контракт — [telegram-pult.md](../telegram/README.md).

**Триаж (lib/analysis/analyzer.ts), устойчивость:** очередь оценок при старте сервера
ВОССТАНАВЛИВАЕТСЯ из статус-файлов (`queued` → снова в очередь; `running` → interrupted,
перезапуск из бейджа топбара). Воркеров — `GRIGDESK_ANALYSIS_CONCURRENCY` (дефолт 2);
git-refresh перед оценкой — не чаще раза в 10 мин (волна задач не дёргает pull каждый раз).
Одна оценка ~5–15 мин: очередь в 70 задач — это часы, «висит» ≠ сломано (смотри /api/analysis).
Триаж зарегистрирован системным default-on плагином. Настройка `triageModel` хранит exact
provider/model/effort и проверяется по свежему provider registry перед каждым dispatch;
`autoArbitrate` по умолчанию выключен. Legacy env только засеивает отсутствующую настройку
при первом старте и дальше не конкурирует с prefs. Все шесть прежних ручек и ручной
`POST /api/tasks/:id/analysis/arbitrate` используют живой gate `plugin_disabled`; off
останавливает новые dispatch, но сохраняет очередь, оценки и `t<id>.clarify.md`.

Claude, Codex с restricted read или именованными permission profiles, GLM, Kimi и DeepSeek
объявляют `scopedWorkspace` ([выбор модели триажа](../pipeline/triage-model-selection.md)):
`PROFILE_AGENT_CWD`, все `PROFILE_AGENT_DIRS`,
`PROFILE_TRIAGE_REPOS` и per-run input — read-only, единственный writable root/cwd — output
staging анализа. Сеть, общие temp-каталоги и внешние MCP закрыты. Claude не получает общий
Bash; команды Codex ограничивает файловый профиль. GLM, Kimi и DeepSeek используют
[файловый брокер и проверку инструментов](../pipeline/triage-executors.md).
Bounded `git log/show` идут через
единственный private `repo_history`. Выбранные изображения сначала проверяются
server-owned token resolver-ом и копируются в input запуска, общий каталог вложений модели
не выдаётся. Это ограничивает последствия prompt injection из B24/Telegram, но не делает
машинную оценку достоверной само по себе.

`questions[]` канонически хранит объекты с вариантами и рекомендацией; старые строки
нормализуются только при чтении. Ответы человека и отдельного triage-arbiter остаются в
одном `t<id>.clarify.md` с server-owned marker actor/status. Арбитр закрывает только
доказуемые по коду вопросы; продуктовый выбор, приоритет и изменение scope остаются человеку.

**Инструкции этапов:** промпты принадлежат опубликованному каталогу маршрутов профиля.
Модель, исполнитель и effort задаются политикой запуска вне route bundle.
Редактор меняет инструкции в черновике; публикация создаёт новую неизменяемую ревизию.

**Раздел «Карта задачи» в промпте разведки — контракт с движком, а не стиль.** Промпт
`routes/bootstrap/prompts/scout.base.md` относительно профиля требует от SCOUT раздел
ровно с этим заголовком: движок достаёт его из `recon.md` и вклеивает в промпт каждого
следующего этапа, чтобы те не выясняли поиском, где что лежит (около пятой части всех
раундов маршрута). Изменения промпта доходят до прогонов только публикацией нового каталога
(`routes/publish.mjs`) и только на НОВОЙ попытке: ни `resume`, ни `goto` каталог не перечитывают.
Формат и потолок 16 КБ описаны в [ENGINE.md](../../engine/ENGINE.md).

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
| Lifecycle isolated-стенда | **GrigDesk** | только для `WORKSPACE_MODE=isolated` |
| Lifecycle shared-стенда | внешний владелец | GrigDesk и engine не создают, не сносят и не перезапускают его |
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
профиля с `task-comment` в хуке `profile_delivery_actions` GrigDesk запускает с
`--task-comment`: узел `ship` оставляет во внешней задаче комментарий со ссылками
на PR (см. [b24.md](../b24/README.md)). Тексты одинаково
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
сразу все ([детали](../chat/executor-integration.md)).
Мутации идут через
`POST /api/providers/:id/usage-actions/:actionId`: ядро разрешает только action из явного
`executor.usageActions`, а смысл и валидация принадлежат адаптеру. Поэтому новый исполнитель
не добавляет vendor-ветки в Fastify или Vue.

Модельный селектор использует каталоги исполнителей, а не список из компонентов: Claude
сканирует установленный бинарь, Codex читает read-only `model/list` app-server с доступом
текущего аккаунта. Живой Codex-каталог и открытый UI обновляются раз в минуту; hidden и
модели с рекомендованным `upgrade` показываются только при включённом «Показывать все модели».

Источник до переноса: docs/grigdesk/architecture.md § Модули сервера (server/src/modules/)
