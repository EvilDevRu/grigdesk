# Тесты и проверка

Веб-тесты на happy-dom, Playwright и ловушки, из-за которых тест врёт.

Читай перед правкой: `tests`.

- [Проверки единого приложения и границы автоматической приёмки](unified-client-checks.md)

## Грабли

- [Transition-stub создаёт inert-предка Teleport-модалки в тесте фокуса](modal-transition-stub.md)

- [Фикстура чистой установки копирует общий код вместе с инструментами](clean-checkout-shared-sources.md)

- [Общий Node-модуль не должен попадать в браузерную программу типов по шаблону](shared-node-typecheck.md)

- [Каталог инструментов не тянет Vue-панели; реестр компилируется с подменами](lazy-panel-imports.md)

- [Лишнее поле прошло схему Fastify: removeAdditional требует проверки propertyNames](fastify-extra-body-fields.md)

- [Единая команда: отдельная песочница, проверенное перекрытие системных команд и ветки b24](cli-sandbox.md)

- [Проверка типов UI должна видеть импортируемые JS-сторы](ui-typecheck-js-imports.md)
- [ResizeObserver окна happy-dom нужно перенести в глобальное окружение теста](happy-dom-resize-observer.md)
- [Изолированный UI preview: область наблюдения Vite и доступ Chromium к loopback](isolated-ui-preview.md)
- [Electron проверяется в одноразовой сессии D-Bus и GNOME Keyring](electron-keyring-isolation.md)
- [Изолированное окружение Electron требует явного backend связки ключей](isolated-electron-password-store.md)
- [Изолированная сессия вернула 1 при PASS внутри = портал документов не снял FUSE-точку doc](isolated-session-doc-portal.md)
- [Локальное окно: наблюдение событий, запрет SW, настоящий вход и SSE](desktop-window-e2e.md)
- [Готовый пакет окна: spawn без inspector, fuses и постоянная шифрованная cookie](desktop-window-package.md)
- [E2E старта окна: корень-фикстура, окружение по списку и отказ через stderr и SIGTERM](desktop-startup-e2e.md)
- [SEA GUI-фикстура: явный выбор местной машины до ожидания рабочего экрана](sea-desktop-fixture.md)
- [Горячая клавиша меню не срабатывает в тесте = Playwright не доводит клавиши до главного процесса Electron](electron-synthetic-keys.md)
- [Файл теста висит до таймаута = в Node остался открытый BroadcastChannel](node-broadcast-channel.md)
- [Сквозной тест «сервер + store окна» не выходит = окно ещё ходит в сервер при закрытии](window-store-fixture-close.md)
- [Очистка общей фикстуры должна регистрироваться вне before](node-test-hook-cleanup.md)

- [Проверка старта сервера использует своё состояние](boot-smoke-state-isolation.md)
- [Тест ждёт сигнал HTTP-фикстуры после отказа исходного хода](async-fixture-producer-failure.md)
- [Намеренное удержание хода расходует общий срок тестовой фикстуры](fixture-held-turn-deadline.md)
- [IPC-барьер может не удержать child до аварийной остановки](ipc-barrier-lifetime.md)
- [Порядок событий проверяется при доставке, а не после опроса](event-order-observer.md)
- [Точное время рендера зависит от подготовки стенда без фиксированных часов](wall-clock-render-fixture.md)
- [Подмена providers adapters оставляет настоящий discovery моделей](providers-offline-fixtures.md)

- [Веб-тест монтирует SFC дважды — а работает со сторами первого теста](sfc-store-isolation.md)
- [Всплывашка открывается только в первом тесте файла = Vue запомнил document первого окна](vue-document-cache.md)
- [Модалка «не открылась» в веб-тесте = стаб Teleport работает только при NODE_ENV=test](teleport-test-environment.md)
- [Сторож, читающий текст задачи, ловит фикстуру, а не страницу](fixture-text-false-positives.md)
- [Тест прошёл по другой причине — правило не проверено вовсе](behavioral-test-coverage.md)
- [Новый импорт в экране валит весь его тест = подмена модуля не экспортирует это имя](view-stub-exports.md)
- [Асинхронные компоненты и composable настроек требуют точных подмен](settings-window-test-stubs.md)
- [Двойник dock store включает ограничение ширины](tool-host-test-store.md)
- [Однострочные пояснения функций прошли незамеченными = сторож читаемости видел только TS в web/](readability-guard-scope.md)
- [Упавший assert с узлом happy-dom съедает всю память — веб-тест запускай через сторож памяти; папка артефактов у тестов настоящая](happy-dom-assert-memory.md)
- [Фоновый Bash может сделать проверку SIGINT ложно красной](background-sigint.md)
- [Пауза в TAP-выводе не доказывает зависание тестов](buffered-test-progress.md)
- [Файл замка остаётся после полного прогона; занятость проверяет flock](full-suite-lock.md)
- [Playwright падает до первой спеки: в общем кэше нет ревизии chromium под версию проекта](playwright-browser-revision.md)
- [Перенаправленный XDG_CACHE_HOME прячет браузеры Playwright](playwright-xdg-cache.md)
- [Удалённый JS-файл валит снимок миграции, хотя код рабочий](migration-inventory-snapshot.md)
- [Тест проходит из корня, но падает из папки своего пакета](package-test-working-directory.md)
- [Настройки роняют вкладку headless-проверки = нужен полный Chromium](headless-shell-settings-crash.md)
- [Тест ждёт `OK`, а утилита пишет `ЦЕЛ` = вывод coreutils переведён на язык машины](coreutils-locale.md)

- [settings-modal-browser-fixture.md](settings-modal-browser-fixture.md) — изолированный стенд общего модала настроек.
