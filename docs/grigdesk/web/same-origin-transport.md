# Интерфейс обращается к своему origin

Production-интерфейс встроен в Electron и APK; его отдаёт локальная труба оболочки. Общий `apiClient.ts` сохраняет относительные
пути API: `api.url(path)` возвращает сам путь, события используют `/api/events`.
`credentials: 'include'`, обработка 401, загрузки и журналирование остаются общими.
WebSocket берёт `location.origin`, заменяя HTTP/HTTPS на WS/WSS и сохраняя хост с портом.
Труба передаёт API, shots и страницы плагинов машине профиля. В dev те же относительные
пути обслуживает Vite proxy; сервер больше не раздаёт web/dist или /ui/<id>/.

«Настройки → Доступ» объясняет автоматический вход по локальному ключу и содержит
привязку телефонов. Парольного входа, смены пароля и выхода нет:
[контракт доступа приложения](../server/desktop-only-access.md).
Ссылки стендов используют прямые HTTP-порты текущего hostname:
[адрес стенда](../plugins/sandbox-host-resolution.md).

Проверки: `tests/web/api-same-origin.test.mts`, `tests/web/sandbox-url.test.mts`,
`tests/web/settings-access.component.test.js`, `tests/web/showcase-view.component.test.js`
и существующие тесты API/журнала окна.
