# Архитектура кокпита

## Слои

```
web (Vue SPA / PWA)  ──HTTP/SSE──▶  server (Fastify, :8140)  ──▶  источники
                                     │
   Pinia stores                      ├─ adapters/factory-state ─▶ ~/.factory/state (файлы)
   (board, tasks, system, ui, pwa)   ├─ adapters/b24 ──────────▶ B24Client (скрейпер портала)
                                     ├─ adapters/system ───────▶ /proc/meminfo, os.cpus
                                     └─ adapters/media ────────▶ ffmpeg + python whisper
```

Сервер — **host-native** (см. [[gotchas]]). Окна (браузер) ходят на сервер по `VITE_BRAIN_URL`
(пусто = тот же origin). Реалтайм — SSE (`/api/events`), `fs.watch` на `~/.factory/state`.

## Модули сервера (`server/src/modules/`)

| Модуль | Эндпоинты | Источник |
|--------|-----------|----------|
| `factory` | `/api/tasks`, `/api/tasks/:id/graph`, `/api/factory/routes`, `/api/factory/stages`, `POST /api/tasks/:id/{launch,sandbox/down}` | `~/.factory/state` + `factory bin` |
| `b24` | `/api/b24/{dashboard,task/:id,users}`, мутации `/api/b24/{tasks,task/:id/*}` | `B24Client` (через очередь `_run`) |
| `system` | `/api/system` (CPU + RAM вкл. swap) | `/proc/meminfo`, `os` |
| `media` | `/api/media/{doctor,upload,ingest/:jobId,extract-frame}` | ffmpeg + whisper |
| `settings` | `/api/settings/b24` (+ `/test`) | `CredsStore` (`.state`) |
| `chat` | `POST /api/chat`, `POST /api/tasks/:id/chat`, `GET/PUT /api/chat/store` | `claude -p` + файлы `chats/` (см. [[chat-agents]]) |
| `agents` | CRUD `/api/agents[/:id]`, `POST /api/agents/reseed` | файлы `agents/<id>.md` (ШАБЛОНЫ: метаданные + заготовка промпта) |
| `routes` | CRUD `/api/routes/:profile[/:id]`, `POST …/reseed` | `routes/<профиль>/<id>.json` + промпты узлов `routes/<профиль>/<id>/<этап>.md` |
| `providers` | `/api/providers` (реестр LLM-исполнителей, кэш 60с) | probe бинарей + `ClaudeAuthStore` |
| `terminal` | `/api/terminal` (WebSocket) | PTY |
| `health` | `/api/health` | — |

Плагины: `sse` (fs.watch → broadcast), `auth` (GET свободно / мутации по `X-Cockpit-Token`),
`static` (web/dist + `/shots` `/demo`, кэш index=no-cache, assets=immutable).

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
У стадий-статусов arsenkin (skeptic/validate/tcritic/simplify) промпт пуст ЗАКОННО — их ведут
промпты соседних стадий (plan/tests/build).

**UI-мелочи:** системный `confirm()` запрещён — единый `shared/ui/confirm.js`
(`await confirmDialog(text, {danger, okText})`, тёмная модалка проекта). Тултип исполнителя
в топбаре показывает потребление лимитов подписки (`/api/providers/usage` →
`executor.usage()`, у claude — OAuth-ручка usage хостового CLI; кэш 60с).

## Данные фабрики

- Реестр прогона: `~/.factory/state/tNNNN.pipeline` — `KEY=VALUE` (не JSON), парс `lib/pipeline-parse`.
- Форма графа: `factory/profiles/<profile>.graph.json` (nodes/keys/optional/routes с pos+edges).
- Статусы узлов: `lib/factory-graph.computeNodeStatuses` — порт `pipeline_statuses` из `dashboard.py`.
- Возвраты: `parseLoops` из `logs/tNNNN.stages.log`. Порты стенда: `tNNNN.env`.
- Стадии — глобальный каталог `lib/stages.js` (enum), профиль оверрайдит подпись/тип.

## Веб (`web/src/`)

- `views/`: Board (доска B24), Pipeline (конвейер + модалка этапа), Agents (база агентов-стадий),
  Chats (телеграм-раскладка чатов), Routes (редактор маршрутов + живой превью), Diff (git-диф на Monaco),
  Video (видео→задачи), Terminal, Settings (на табах: Битрикс24 / Исполнители), TaskModal,
  ChatPanel (плавающий чат на всех страницах, кроме `/chats`).
- `views/pipeline/FactoryGraph.vue` — SVG-граф; геометрия/кривые в `shared/graph-geom.js`
  (порт `node_geom`/`edge_path`); автораскладка маршрутов — `shared/route-layout.js`.
- `stores/`: `board` (кеш доски + поллинг), `tasks` (кеш деталей + действия), `system`, `ui`
  (модалка задачи), `pwa` (баннер обновления), `chat` (мультисессии, история на сервере),
  `diff`, `providers` (реестр исполнителей), `ui-context` (что открыто — для чата).

## Гашение b24-mcp

Кокпит заместил b24-mcp: доска+действия (перенос `B24Client`), медиа/видео (перенос whisper),
вход в фабрику (кнопка «На конвейер»). Скиллы `/commit-task` `/pr-fixes` `/b24` → CLI `bin/b24`.
MCP отключён (регистрация/хуки/контейнеры сняты). Подробности переноса — в CLAUDE.md.
