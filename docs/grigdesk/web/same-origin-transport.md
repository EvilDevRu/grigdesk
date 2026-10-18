# Интерфейс обращается к своему origin

Production-интерфейс отдаёт сам сервер. Общий `apiClient.ts` сохраняет относительные
пути API: `api.url(path)` возвращает сам путь, события используют `/api/events`.
`credentials: 'include'`, обработка 401, загрузки и журналирование остаются общими.
WebSocket берёт `location.origin`, заменяя HTTP/HTTPS на WS/WSS и сохраняя хост с портом.
В dev те же относительные пути обслуживает Vite proxy.

«Настройки → Доступ» объясняет автоматический вход по локальному ключу и содержит
привязку телефонов. Парольного входа, смены пароля и выхода нет:
[контракт доступа приложения](../server/desktop-only-access.md).
Ссылки стендов используют прямые HTTP-порты текущего hostname:
[адрес стенда](../plugins/sandbox-host-resolution.md).

Проверки: `tests/web/api-same-origin.test.mts`, `tests/web/sandbox-url.test.mts`,
`tests/web/settings-access.component.test.js`, `tests/web/showcase-view.component.test.js`
и существующие тесты API/журнала окна.
