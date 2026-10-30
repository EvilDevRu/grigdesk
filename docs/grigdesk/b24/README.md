# Задачи Б24

Клиент портала, статусы, доска, полка и личное состояние задач.

Читай перед правкой: `server/src/lib/b24`, `server/src/modules/b24`, `server/src/modules/task-shelf`, `server/src/modules/task-favorites`, `server/src/modules/task-seen`, `web/src/views/board`, `web/src/views/shelf`, `b24/` (команда `b24`).

## Устройство

- [Поля доски и переключатель контроля: общий рабочий режим, фон и скругления](board-control-styles.md)

- [Собственные задачи GrigDesk: создание, номера, карточка и чтение без Б24](grigdesk-tasks.md)
- [Маршрутизация чтения карточки: диапазон own lookup и совместимость Б24](task-source-routing.md)
- [Действия карточки Б24 до загрузки деталей и готовность формы правки](task-source-readiness.md)

- [Размещение карточки: отдельные окна desktop, диалог браузера и пассивная полка](task-card-placement.md)

- [Оформление карточки: единая навигация, описание и разбор, сохранение черновиков](../web/task-detail-design.md)

- [Авторизация и слои](authentication-layers.md)
- [Граница B24](integration-boundary.md)
- [Личное состояние задач B24 живёт на сервере, а не в браузере](server-owned-task-state.md)
- [Личное состояние задач: избранное, полка и просмотренное](personal-task-state.md)
- [Полка не является фильтром доски и не связана с избранным](task-shelf-independence.md)
- [Протокол портала](portal-protocol.md)
- [Статусы и приоритет обработки](statuses-and-priority.md)
- [Действия завершённой задачи в карточке](completed-task-actions.md)
- [CLI для агента и оператора](agent-and-operator-cli.md)
- [Команда b24: один исполняемый файл, настройки, коды выхода и установка](binary-cli.md)
- [HTTP API GrigDesk](http-api-grigdesk.md)

## Грабли

- [Проверка снимка доски принимает числовой Unix-старт таймера](board-snapshot-timer.md)
- [Таймер задачи: timer_elapsed из B24 всегда 0 — считать от timer_started_at](task-timer-calculation.md)
- [B24Client НЕ потокобезопасен — все вызовы через очередь _run](client-request-queue.md)
