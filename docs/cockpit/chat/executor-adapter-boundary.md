# Подключение нового ИИ — модульное

- **Подключение нового ИИ — модульное:** один файл в `server/src/lib/executors/` (контракт в
  `executors/index.js`: id/name/color/probe/auth/efforts/seedModels/catalog/run и необязательный
  `catalogCacheKey`; телеметрию последнего запроса `run` нормализует в `contextCache`).
  Для безопасного trusted-триажа adapter отдельно объявляет `scopedWorkspace` и принимает
  `workspaceAccess` с раздельными readable/writable roots; одного plan-mode недостаточно.
  Папка сканируется при старте — ядро (providers, chat)
  про вендоров не знает. Сейчас: `claude.js`, `codex.js`, `kimi.js`, `ollama.js`.
- `GET /api/providers` — `{ id, name, vendor, bin, color, version, auth, authLabel, available, installed, models[], modes[], settings[] }`.
  Тарифной отсечки в описании provider-а нет: факты prompt cache относятся к конкретному
  model request и приходят через `contextCache`, а не через этот каталог.
  Кэш 60с, `?refresh=1`. Топбар рисует иконки (серый = недоступен), настройки → вкладка «Исполнители».

- **Вкладка «Исполнители» — плашка на каждого ИИ, плашки горизонтальным рядом** (grid
  `minmax(340px, 1fr)`, таб шире остальных: `.settings.wide`). В плашке — факты про CLI
  (авторизация, версия, каталог, обновление) и блок **своих настроек исполнителя**; общее
  для всех («показывать все модели», «Перепроверить», доверенные каталоги) — карточками ниже.

Источник до переноса: docs/cockpit/chat-agents.md § Подключение нового ИИ — модульное:
