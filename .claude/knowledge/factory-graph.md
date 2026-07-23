# Порт конвейера (SVG-граф)

Граф конвейера — точный порт `factory/lib/dashboard.py` (server-rendered Python) в Vue+JSON.
Разнесён: **сервер** считает данные, **клиент** рисует геометрию.

## Сервер (`server/src/lib/factory-graph.js`)

- `loadGraph(factoryHome, profile)` — читает и кеширует `profiles/<profile>.graph.json`.
- `graphForRoute(g, route)` — узлы (оверрайд профиля поверх каталога `stages.js`), keys, optional, vb, pos, edges.
- `computeNodeStatuses({ pf, pos, keys, optional, mtimeMs })` — **порт `pipeline_statuses`**:
  - `_ST_MAP`: done/approved→done, running→run, waiting→wait, failed/rejected→stall, blocked→skipbad.
  - `skipped` у optional-узла → `skip`, иначе `skipbad` (аномалия).
  - idle-заполнение (незаписанные этапы до последнего тронутого = «нет данных»).
  - ворота ждут, если всё до них done/skip; гард «преждевременно» при недоделанном хвосте.
  - инвариант линейности (активен ровно один узел); возврат после reject приёмки.
- `parseLoops(stagesLog)` — возвраты `возврат в X из-за KEY` → счётчик по узлу; `halted`.

`getTaskGraph(task)` собирает всё + `nodeMeta` (AT/DUR/FANOUT/FAILS/TOKENS для модалки этапа) +
`progress` (done/total/current) + порты стенда из `tNNNN.env`.

## Клиент (`web/src/shared/graph-geom.js`)

**Порт `node_geom`/`edge_path`** (1:1 с dashboard.py):
- `nodeGeom`: `code` → ромб (hw 70, hh 27); иначе прямоугольник, `hw = max(58, ([...label].length+2)*3.8+14)`,
  hh 17. **`[...label].length`** (код-пойнты, эмодзи=1) — иначе рёбра промахиваются по краям.
- `edgePath`: 12 типов маршрутизации (`h`, `v`, `arc_up`/`_hi`, `arc_down`/`_hi`/`_x2`/`_x3`,
  `arc_reject`, `to_sandbox`/`from_sandbox`) — кубические Безье с ручными коэффициентами. START_DOT=(30,55).
- `computeViewBox` — тесный холст по узлам (порт `graph_viewbox`), убирает пустоту зашитого vb.

`FactoryGraph.vue` рисует: узлы по типу (агент/человек/код — рамки), 9 статусов (`ns-*`: обводка/
заливка/пульс/свечение), рёбра (`e-off`/`e-on`/`e-flow` «ток» / `e-fail`/`e-loop` возвраты), метки
(`MARKS`). `reference`-режим — эталонная схема без статусов (раздел «Маршруты»). Клик по узлу →
`emit('node')` → модалка этапа.

## Палитра

Тёмная тема старого дашборда: фон `#0b0d11`, карта `#151920`, `--accent`(info) `#5aa2ff`,
good `#3fb950`, warn(serious) `#e0a33a`, bad(critical) `#f0564c`, рамки узлов агент `#e0873f` /
человек `#d9c04a` / код `#37b7c3`, ребро-возврат `#7c4038`. Всё в `web/src/styles.css`.

## Стадии — глобальный enum (`server/src/lib/stages.js`)

`STAGES` — каталог всех стадий (kind + подпись по умолчанию), `StageKind` (agent/human/code).
Профили ССЫЛАЮТСЯ на id и оверрайдят через graph.json (`resolveNode`). `GET /api/factory/stages`.
Задел под будущий редактор профилей: стадии выбираются из каталога, не описываются с нуля.
