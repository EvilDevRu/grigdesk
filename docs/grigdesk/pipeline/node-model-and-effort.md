# Модель и effort в модалке узла

На [вкладке «Исполнители»](node-dialog-design.md) модель и effort показаны отдельными
отключёнными полями. Их редактирование пока не подключено: визуал не создаёт локальный
выбор и не отправляет модель или effort в API. История запусков находится в «Журнале».

Маршрут не несёт model policy: его `runKey` только выбирает stage, а
`server/src/lib/runnerState.ts` резолвит `MODEL_<STAGE>_<PROVIDER>_*` →
`MODEL_DEFAULT_<PROVIDER>_*` из `profiles/<profile>/runners.env`. API отдаёт результат в
`nodeMeta.<node>.runner.models[provider]`.

В цепочке исполнителей модель и effort показаны одной строкой, например
`gpt-5.6-sol · effort ultra`. Если provider уже запускался, UI берёт effort последней его
попытки из `runner.attempts[].effort`; это значение launcher записал в
`logs/runs/t<TASK>/<STAGE>/<RUN>/meta.env`.
Так завершённый этап продолжает показывать фактический effort даже после смены policy.
До первого запуска или при legacy telemetry без `EFFORT` используется effective policy.
Строки «Попытки запуска» всегда показывают собственные `model · effort`, когда эти поля
присутствуют, и не приписывают исторической попытке новое значение из профиля.

Источник до переноса: docs/grigdesk/factory-graph.md § Модель и effort в модалке узла
