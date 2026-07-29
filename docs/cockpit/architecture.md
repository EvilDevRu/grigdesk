# Архитектура кокпита

## Слои

```
web (Vue SPA / PWA)  ──HTTP/SSE──▶  server (Fastify, :8140)  ──▶  источники
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
| `settings` | `/api/settings/{prefs,factory-debug,b24}` | prefs, engine debug CLI, `CredsStore` |
| `chat` | `/api/chat*`, `/api/tasks/:id/chat`, история/вложения/permission | выбранный executor + `chats/` ([детали](chat-agents.md)) |
| `agents` | CRUD `/api/agents[/:id]`, `POST /api/agents/reseed` | файлы `agents/<id>.md` (ШАБЛОНЫ: метаданные + заготовка промпта) |
| `routes` | `/api/profiles`, CRUD `/api/routes/:profile[/:id]`, `POST …/reseed` | `routes/<профиль>/` + `profiles/*/graph.json` |
| `providers` | `/api/providers*` (модели, usage, credits, обновления CLI) | `lib/executors/*` + локальный реестр моделей |
| `analysis` | `/api/analysis*` | очередь и статус-файлы в `~/.factory/analysis` |
| `projects`, `code` | `/api/projects*`, read-only `/api/code/:project/*` | профили/prefs + git/worktree |
| `plugins`, `demo` | `/api/plugins*`, `/api/demo*`, `/api/ext/<id>/*` | системный реестр + `plugins/<id>/` |
| `auth`, `gateway` | `/api/auth*`, `/api/gateway/{authz,tls-allow}` | сессии, CLI token, внешний Caddy |
| `terminal` | `/api/terminal` (WebSocket) | PTY |
| `health` | `/api/health` | — |

Fastify-плагины: `sse` (fs.watch → broadcast), `auth` (весь `/api`, WS, `/shots` и `/demo`
закрыты сессией; исключения — login/setup/state и gateway TLS allow; локальные CLI используют
`X-Cockpit-Token`), `static` (web/dist, кэш index=no-cache, assets=immutable).

**Триаж (lib/analysis/analyzer.js), устойчивость:** очередь оценок при старте сервера
ВОССТАНАВЛИВАЕТСЯ из статус-файлов (`queued` → снова в очередь; `running` → interrupted,
перезапуск из бейджа топбара). Воркеров — `COCKPIT_ANALYSIS_CONCURRENCY` (дефолт 2);
git-refresh перед оценкой — не чаще раза в 10 мин (волна задач не дёргает pull каждый раз).
Одна оценка ~5–15 мин: очередь в 70 задач — это часы, «висит» ≠ сломано (смотри /api/analysis).

**Агенты и промпты (модель данных):** агент в `agents/` — переиспользуемый ШАБЛОН роли
(один id = один шаблон, коллизий и суффиксов `-<профиль>` больше нет, `.remap.json` умер).
У шаблона явные `model` и `effort`: селекты в редакторе строятся из реестра исполнителей
(`/api/providers`, без хардкода списков); `''` = сессионная модель / дефолт движка.
Посев обновляет метаданные, но НЕ трогает курируемые поля: `prompt` (заготовка) и `effort`.
Боевой промпт каждого этапа принадлежит СХЕМЕ: сайдкар `routes/<профиль>/<маршрут>/<этап>.md`.
При добавлении узла в конструкторе заготовка копируется из шаблона в схему (инстанцирование)
и дальше живёт своей жизнью; правка шаблона расставленные узлы НЕ меняет. В редакторе маршрутов
клик по узлу → «Промпт этапа» (кнопки «Из шаблона» и «Применить во все схемы» — разнести общий
текст, например уроки прогонов, по всем схемам проекта). Пустой промпт = сайдкар удаляется;
промпты в `<id>.json` не живут (только сайдкары). Посев: метаданные шаблона — первый профиль
по алфавиту, а ЗАГОТОВКА промпта посевом не трогается (курируется руками, обезличенные скелеты
ролей без проектных путей); промпты узлов каждого профиля — из его bash-профиля
(`extractProfilePrompts` в agents/seed.js).
У стадий-статусов профиля проекта (skeptic/validate/tcritic/simplify) промпт пуст ЗАКОННО — их ведут
промпты соседних стадий (plan/tests/build).

**UI-мелочи:** системный `confirm()` запрещён — единый `shared/ui/confirm.js`
(`await confirmDialog(text, {danger, okText})`, тёмная модалка проекта). Тултип исполнителя
в топбаре показывает потребление лимитов подписки (`/api/providers/usage` →
`executor.usage()`, у Claude — OAuth-ручка usage хостового CLI; кэш 60с). Ответ всегда
структурирован: бары не исчезают при временной ошибке, а помечаются устаревшими; 401/403,
429, отсутствие авторизации и отсутствие usage API имеют отдельные сообщения и действия.

## Данные фабрики

- Реестр прогона: `~/.factory/state/tNNNN.pipeline` — `KEY=VALUE` (не JSON), парс `lib/pipeline-parse`.
- Форма графа: `<config.profilesDir>/<profile>/graph.json` (по умолчанию локальный корневой
  `profiles/`, целиком вне Git) (nodes/keys/optional/routes с pos+edges).
- Статусы узлов: `lib/factory-graph.computeNodeStatuses` — порт `pipeline_statuses` из `dashboard.py`.
- Возвраты: `parseLoops` из `logs/tNNNN.stages.log`. Порты стенда: `tNNNN.env`.
- Стадии — глобальный каталог `lib/stages.js` (enum), профиль оверрайдит подпись/тип.
- После запуска Cockpit модуль factory один раз проверяет незакрытые реестры. Мёртвый демон
  возобновляется только вне ворот/human-stall и с лимитом три рестарта за 15 минут;
  настройка `autoRecoverPipelines` отключает это поведение.

## Веб (`web/src/`)

- `views/`: Board (доска B24), Pipeline (конвейер + модалка этапа), Agents (база агентов-стадий),
  Chats (телеграм-раскладка чатов), Routes (редактор маршрутов + живой превью),
  Projects, Code (read-only дерево/файл/git), Diff (Monaco), Video, Demo, Terminal,
  Settings (Битрикс24 / Исполнители / Запуски / Плагины / Сервер / Доступ), Login,
  TaskModal и ChatPanel.
- `views/pipeline/FactoryGraph.vue` — SVG-граф; геометрия/кривые в `shared/graph-geom.js`
  (порт `node_geom`/`edge_path`); автораскладка маршрутов — `shared/route-layout.js`.
- `stores/`: `board` (кеш доски + поллинг), `tasks` (кеш деталей + действия), `system`, `ui`
  (модалка задачи), `pwa` (баннер обновления), `chat` (мультисессии, история на сервере),
  `analysis`, `auth`, `diff`, `plugins`, `providers` (реестр исполнителей),
  `ui-context` (что открыто — для чата), `notify-watch` (что на конвейере встало на человеке).
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
