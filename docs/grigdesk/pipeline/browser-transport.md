# Браузер этапа конвейера

Доступ этапа требует одновременно durable mode grigdesk, pinned policy.browser=allow,
точную активную attempt/run identity и действующий browser token. Параметры модели
не выбирают задачу, проект, attempt или машину. Protected binding, live process identity
и trusted ledger сверяются вместе; stale active не подменяет новый attempt.

## Подготовка и транспорт

Reservation объединяет статусный и browser runtime. Launcher готовит transport до fork,
публикует binding и запускает relay до CONT. Завершение, TERM, fault и runtime switch
убирают только собственные capability/relay. Forbid не получает descriptor, nonce и relay.
Текущая старая pinned попытка без browser helper capability не получает её задним числом.

Выбранный runtime передаёт GRIGDESK_BROWSER_NODE, GRIGDESK_BROWSER_HELPER и
GRIGDESK_BROWSER_RELAY_SOCKET. Они перечислены в HOST_ENV_SUFFIXES, который используется
диагностикой старых имён окружения.

Claude/Codex/Kimi используют factory-browser CLI и приватный mailbox/socket.
JSON request не передаёт секрет в argv. Codex получает ровно необходимые readonly roots,
mailbox и evidence root; canonical shell exemption допускает только точную команду,
не chains. FD9 binding reader не сдвигает status FD7. Prompt не содержит token.

DeepSeek/GLM используют host-owned factory-status MCP вне tool sandbox. Инструмент
браузера добавляется условно к точному inventory разрешённого этапа. Child env получает
nonce после общей фильтрации окружения, но MCP YAML, overlay, hooks и model context его
не сериализуют. State-only filesystem этим не расширяется. Реальный pinned stdio
проверяется отдельно от synthetic dispatch.

## Прекращение доступа

Broker проверяет proof при enqueue, выдаче и принятии результата. Pause, terminal,
удаление, смена visit/node/attempt/epoch, смерть процесса и PID reuse запрещают новые
команды и результаты старого запуска. Одна уже выданная native-команда может закончиться
до deadline 15 секунд; человеческий local revoke блокирует следующие CDP-эффекты.
Автоматического повтора click/submit после потери ответа нет.

Отсутствие живого окна при grigdesk mode даёт отказ, не legacy fallback. Приложение
должно работать; запуск браузера при закрытом приложении и туннель к стенду не входят
в этот транспорт. Человеческое открытие стенда не выдаёт agent grant.

## Поставка и проверки

SEA helper manifest включает factory-browser с явным main/export и нужными resources.
Проверяются source entry, relocation helper build и packaged fixture. Engine discovery
включает contract/browser-transport.sh штатно. tests/run-all.sh дополнительно запускает
browser-*.test.mts для desktop/server/web, factory-browser-*.test.mts и open-stand.test.mts
через memory guard с concurrency=2. JS-тесты UI/chat wiring входят в прежние npm globs.
Electron smoke запускается отдельно от worker cache/profile тестов.

Смежные контракты: [доступ в чате](../chat/browser-access.md),
[native-окно и настройки](../web/browser-workspace.md),
[упакованные helpers](../server/server-binary-factory-helpers.md).
