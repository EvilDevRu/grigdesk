# Доступ агента к браузеру

Инструмент `grigdesk_browser` доступен через общий registry исполнителей. Сервер
создаёт owner из durable chat ID и project scope. Модель передаёт действие и payload;
она не назначает себе чат, проект, машину или владельца из текста страницы/UI-контекста.
Contribution, policy, executor options и scope fingerprint учитывают browser intent.
Отключение доступа действует и на ранее созданную closure инструмента.

Агент автоматически получает созданные им вкладки. Человеческая вкладка имеет
owner=null; подпись исходной задачи служит данными. Для работы агента её нужно явно
передать. «Приостановить» останавливает очередь и следующие CDP-эффекты,
«Продолжить» возобновляет доступ, «Отозвать» снимает grant. Уже переданный ввод
не откатывается. Revoke/regrant тому же owner не оживляет команды старого epoch.

## Действия и недоверенные данные

Действия: list, open, snapshot, click, fill, scroll, screenshot, console, close.
Управляемые URL — абсолютные HTTP(S), без credentials и управляющих символов.
Snapshot возвращает refs текущего наблюдения, не исполняемый текст. Текст страницы
и console помечены untrusted. Навигация инвалидирует refs; другой origin требует
ручной передачи управления. Общий доступ к браузеру не делает инструкцию сайта правом.

Лимиты контракта: URL 8192 символа, ввод 10000, snapshot 24000/200 элементов,
console 100 записей по 2000, JPEG до 2 MiB и шириной до 1280. Codex dynamic tool
response сохраняет image content; CLI evidence публикуется как проверенный imagePath.

Автоматическое закрытие агентских вкладок после пяти минут простоя и отличие от
личного списка агента описаны в [контракте времени жизни вкладок](browser-tab-limits.md).

## Доступность и отказы

Durable server mode legacy/grigdesk независим от живого host. Закрытое окно даёт
browser_unavailable, не запускает скрытый браузер. Явное отключение требует server ACK.
Предпочтение маршрута GrigDesk не обещает запрет других браузеров агенту с shell.
Внешний браузер человека автоматически управляемым не становится.

Host token передаётся только в заголовке X-GrigDesk-Browser-Host. Он не попадает
в URL, SSE или tool inventory. API работает под общим session auth guard;
broker сверяет owner при enqueue, poll и result. Отсутствие сессии даёт 401,
конкурирующий host без явного takeover — 409. Команда ограничена 15 секундами.

Проверки: browser-chat-owners/policy/wiring, browser-executor, browser-api,
browser-broker/access и factory-browser-environment. Настройки и устройство окна —
в [документе браузера](../web/browser-workspace.md).
