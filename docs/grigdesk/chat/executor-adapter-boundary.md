# Подключение нового ИИ — модульное

- **Подключение нового ИИ — модульное:** один файл в `server/src/lib/executors/` (контракт в
  `executors/index.ts`: id/name/color/probe/auth/efforts/seedModels/catalog/run и необязательный
  `catalogCacheKey`; телеметрию последнего запроса `run` нормализует в `contextCache`).
  Для безопасного trusted-триажа adapter отдельно объявляет `scopedWorkspace` и принимает
  `workspaceAccess` с раздельными readable/writable roots; одного plan-mode недостаточно.
  Папка сканируется при старте — ядро (providers, chat)
  про вендоров не знает. Сейчас: `claude.ts`, `codex.ts`, `deepseek.ts`, `glm.ts`, `kimi.ts` (`glm.ts` — setup-only,
  пока режим доступа не допущен), `tripo.ts` — API кредитов и раздела 3D без чата.
- Необязательные `type` и `kind` отделяют тип работы от транспорта. Общий
  `isChatExecutor` требует `run` и нормализованный `universal`; узкий адаптер не
  получает модели даже с ошибочно объявленным transport. Подробнее —
  [типы исполнителей](executor-types.md).
- `GET /api/providers` содержит `id`, `name`, `vendor`, нормализованный `type`,
  `kind` (`api` по декларации, иначе `cli`), `chatEnabled`, `bin`, `color`, `version`,
  `auth`, `authLabel`, `available`, `installed`, `models[]`, `modes[]`, `settings[]`.
  Тарифной отсечки в описании provider-а нет: факты prompt cache относятся к конкретному
  model request и приходят через `contextCache`, а не через этот каталог.
  Кэш 60с, `?refresh=1`. Топбар рисует иконки (серый = недоступен), настройки → вкладка «Исполнители».

- Вкладка «Исполнители» показывает реестр вертикальной
  [гармошкой](../web/executor-settings-accordion.md): сводки CLI видны всегда,
  настройки, ресурсы и MCP раскрываются у одного ИИ. Общее для всех
  («показывать все модели», «Перепроверить») остаётся отдельной карточкой ниже.

Рабочую папку описывает capability `workdir` (`switch`, `roots`) или функция от config.
Опциональный `validateWorkdir` разделяет детерминированные проверки preview и runtime;
правила конкретного вендора остаются внутри адаптера. Подробности — [workspace](chat-workspace.md).
