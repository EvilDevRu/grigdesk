# Задачи Б24

Читай при изменении драйверов трекеров, доски, карточки и личного состояния задач.

Драйверы трекеров, совместимый HTTP-фасад, доска, полка и личное состояние задач.

Читай перед правкой: `server/src/lib/trackers`, `server/src/modules/tracker`, `server/src/modules/task-shelf`, `server/src/modules/task-favorites`, `server/src/modules/task-seen`, `web/src/views/board`, `web/src/views/shelf`, `tracker/` (команда `tracker`).

## Устройство

- [Задача №2: удаление встроенной доски, резерв own и сохранение default](own-board-retirement.md)

- [Несколько драйверов: дефолт, адресный триаж и запуск, хранение и CLI](multi-driver-board.md)

- [Общий список внешних источников и личные метки](unified-board.md)
- [Автоматическая схема HTTPS для адреса портала без схемы](portal-url-scheme.md)
- [Валидация API-токенов: непрозрачное значение, ошибки вставки и проверка перед сохранением](token-validation.md)
- [Порядок проверки нескольких драйверов до сетевых проб и записи](settings-validation-order.md)
- [Проверка соединения: черновик реквизитов, отдельная сессия и нейтральные ошибки](connection-test.md)
- [Поля карточки, мутации чек-листа, тегов, приёмки и REST-факты таймера](task-card-fields.md)
- [Корень чек-листа Б24: именованный список без чекбокса и создание без PARENT_ID](checklist-roots.md)
- [Новый пункт: явные Сохранить/Отмена и подтверждение без следующей пустой строки](checklist-item-editor.md)
- [Строковые подписи доски из объектов REST Битрикс24](stock-board-projection.md)
- [Удаление внешней задачи и завершение нового модуля Битрикс24](task-delete-completion.md)
- [Декларативные настройки: select и условная видимость](tracker-settings-schema.md)
- [Чтения внешнего сессионного драйвера: signal, очередь и поколения](driver-read-lifecycle.md)
- [Имена пакетов владельца: id, версия и соответствие папке](driver-package-names.md)
- [Удаление драйвера: кнопка в настройках, подтверждение, drain, выбор доски и реквизиты](driver-removal.md)
- [Источники драйверов: встроенные ярлыки, локальная надстройка и API установщика](driver-sources.md)
- [Каталог внешних драйверов: умолчание и GRIGDESK_DRIVERS_DIR](driver-directory.md)
- [Нейтральный API трекера и обновление клиентов](neutral-tracker-api.md)
- [Нейтральная идентичность и прежние хеши личных данных](tracker-account-scope.md)
- [Граница внешних драйверов и статусная семантика](external-driver-boundary.md)
- [Границы драйверов, возможности Б24/Jira и правила поставки](tracker-drivers.md)
- [Обновление карточки, колонка времени и ряды виджетов трекера](tracker-ui-refresh.md)
- [Общий срок чтения, подписчики, HTTP-отмена, cookie и диагностика](read-operation-lifecycle.md)
- [Поля доски и переключатель контроля: общий рабочий режим, фон и скругления](board-control-styles.md)
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
- [Команда tracker: один исполняемый файл, настройки, коды выхода и установка](binary-cli.md)
- [HTTP API GrigDesk](http-api-grigdesk.md)

## Грабли

- [404 мутации внешнего драйвера: собственный класс ошибки пакета](driver-mutation-errors.md)
- [Ожидание Б24 задерживает локальные метки и занимает соединения интерфейса телефона](read-queue-stalls.md)
- [Проверка снимка доски принимает числовой Unix-старт таймера](board-snapshot-timer.md)
- [Таймер задачи: timer_elapsed из B24 всегда 0 — считать от timer_started_at](task-timer-calculation.md)
- [Общая очередь сессионного драйвера и смена реквизитов](client-request-queue.md)
