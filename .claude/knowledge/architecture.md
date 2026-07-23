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
| `health` | `/api/health` | — |

Плагины: `sse` (fs.watch → broadcast), `auth` (GET свободно / мутации по `X-Cockpit-Token`),
`static` (web/dist + `/shots` `/demo`, кэш index=no-cache, assets=immutable).

## Данные фабрики

- Реестр прогона: `~/.factory/state/tNNNN.pipeline` — `KEY=VALUE` (не JSON), парс `lib/pipeline-parse`.
- Форма графа: `factory/profiles/<profile>.graph.json` (nodes/keys/optional/routes с pos+edges).
- Статусы узлов: `lib/factory-graph.computeNodeStatuses` — порт `pipeline_statuses` из `dashboard.py`.
- Возвраты: `parseLoops` из `logs/tNNNN.stages.log`. Порты стенда: `tNNNN.env`.
- Стадии — глобальный каталог `lib/stages.js` (enum), профиль оверрайдит подпись/тип.

## Веб (`web/src/`)

- `views/`: Board (доска B24), Pipeline (конвейер + модалка этапа), Routes (эталонные схемы +
  фильтр профилей), Video (видео→задачи), Settings, TaskModal (управление задачей).
- `views/pipeline/FactoryGraph.vue` — SVG-граф; геометрия/кривые в `shared/graph-geom.js`
  (порт `node_geom`/`edge_path`).
- `stores/`: `board` (кеш доски + поллинг), `tasks` (кеш деталей + действия), `system`, `ui`
  (модалка задачи), `pwa` (баннер обновления).

## Гашение b24-mcp

Кокпит заместил b24-mcp: доска+действия (перенос `B24Client`), медиа/видео (перенос whisper),
вход в фабрику (кнопка «На конвейер»). Скиллы `/commit-task` `/pr-fixes` `/b24` → CLI `bin/b24`.
MCP отключён (регистрация/хуки/контейнеры сняты). Подробности переноса — в CLAUDE.md.
