# Браузерный стенд настроек

`tests/web/e2e/settings-modal.e2e.mjs` запускается отдельно от компонентных тестов.
Helper `fixtures/settings-modal/browser.mjs` поднимает собственный Vite без web-конфига
и env-файлов, с отключённым наблюдением и кэшем внутри GRIGDESK_ARTIFACTS_DIR/browser.

Entry монтирует настоящий SettingsModal над простой страницей и общий UiDialogHost.
API перехватывается context.route: неизвестный путь получает 500 и фиксируется в списке,
который сценарий обязан проверить. SSE обслуживает middleware стенда. pageerror и
необработанные rejection входят в ошибки проверки. Полный Chromium выбран явно.

UI00 проверяет открытие и сохраняет снимок 1280×800. Последующие страницы проверяются
на том же стенде с явными публичными DTO, без работающего GrigDesk и платных API.
Стенд не включается в test:components или общий run-all.

Entry использует настоящую createWebHashHistory, guard и пустой route stub настроек.
Основная синтетическая страница содержит текст, собственную прокрутку и счётчики
mount/unmount; anchor и hash проверяют сохранение того же DOM. UI01–10 измеряют шесть
размеров, header/footer, независимый scroll, поиск и draft на 390, keyboard tree,
ошибку/empty/loading и вложенный touch-диалог. PNG сохраняются в artifacts/browser.
Масштаб здесь моделируется доступным CSS viewport; настоящий setZoomFactor — в Electron.
