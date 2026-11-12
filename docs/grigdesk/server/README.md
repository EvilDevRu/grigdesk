# Сервер и доступ

- [Профили доступа исполнителей: приватные ревизии, восстановление и сохранение прежнего .env](../chat/access-profile-rules.md)

Читай при изменении запуска, установки, доступа, поставки и конфигурации сервера.

Запуск и юнит, авторизация, переменные машины, сеть.

Схема приложения и двух входов описана в [устройстве единого приложения](../overview/unified-client.md).

Читай перед правкой: `server/src/app.ts`, `server/src/plugins`, `server/src/modules/auth`, `bin`, `deploy`.

## Устройство

- [Серверное задание relay: общий API, выбор и отмена ожидания, SSH, порт и откат VPS](relay-setup.md)

- [Остановка до выхода ОС: независимые сторожа worker, потеря launcher, код 75 и поэтапный журнал](shutdown-watchdogs.md)
- [Изоляция статистики и Telegram: отдельный Node, сроки, лимиты и освобождение DNS](isolated-statistics-fetch.md)
- [Ротация stdout/stderr, gzip-архивы и чтение всех частей журнала окна](log-rotation.md)
- [Времена HTTP, ожидания, цикл событий, CPU и GC](runtime-performance.md)
- [Единый режим допуска GLM при установке сервера и DeepSeek](server-install-glm-mode.md)
- [Условная правка .env: сверка прежнего значения под очередью писателя](env-file-expected-value.md)
- [Исходный PATH/prefix и приватная проверка Bash для внешних CLI](user-cli-parent-environment.md)
- [Подтверждение TLS-привязки, готовность relay и диагностика отказов](phone-pairing-confirmation.md)
- [Управляемый direct-вход, PHONE:2 и общий client relay](phone-access.md)
- [Первый импорт папки данных, синхронный граф и отдельный поиск CLI/AppImage](early-data-home-imports.md)
- [Автономный установщик: потоковый хвост архивов, ограничение postject и проверка ELF](installer-archive-tail.md)
- [Подписанный канал сайта: CI, статические маршруты origin, публикация и восстановление](site-release-channel.md)
- [Ручной выбор full/skip, причина, identity и запись решения в выпуске](release-test-selection.md)
- [Release workflow: ручной full/skip, этапы, логи, явные install-скрипты и проверенные загрузки](release-workflow-validation.md)
- [Stable из проверенных исходников: полный run, проверка пакетов и сверка Git-дерева](release-validation-reuse.md)
- [Фоновый реестр исполнителей: бюджет 1,2 с, сохранение карточек при переименовании, wait и refresh](providers-background-read.md)
- [Прогресс сборки без мерцания и предложение открыть окно после успеха](cli-build-interaction.md)
- [Пустой вызов CLI: меню или справка, открытие окна только по явному действию](cli-default-command.md)
- [Терминальное меню CLI: язык, прогресс, уборка с подтверждением и прерывание](cli-terminal-menu.md)
- [Явная уборка артефактов: барьер lock-ов, fd-защита путей, отмена и линейные обходы](artifacts-cleanup.md)
- [Оформление меню: тёмная палитра, выбор, ширина и безопасные стили](cli-menu-rendering.md)
- [Общие экраны консоли: состояния, команды, ввод, QR, журналы и сборка](cli-terminal-screens.md)
- [Переносимая папка: свежая сборка, архив, первый запуск и меню](portable-bundle.md)
- [Каталог плагинов: автоматический выбор сайта и закрытый локальный API](../plugins/plugin-marketplace.md)
- [Сборка из исходников: сверка серверных npm-зависимостей, сервер, веб, окно и задачи Б24](ctl-build.md)
- [Android APK в меню сборки и отдельной команде, пути и ошибки](ctl-build-apk.md)
- [Полная сборка привязывает окно к новому серверу при следующем запуске](build-server-selection.md)
- [E0 без baseline: функциональные ворота, cold-порог и приватный HOME независимо от umask](server-binary-smoke-baseline.md)
- [Выбор ELF/R/source и владение preparation в окне](server-binary-desktop.md)
- [Сервер одним ELF: I/D/R, argv, launcher, приёмка и действия владельца](server-binary.md)
- [Установка, private receipt и откат серверного ELF](server-binary-install.md)
- [Пересборка проверяет совместимость сервера с установленными DeepSeek/GLM до замены](server-executor-install-guard.md)
- [PATH одиночного ELF: пользовательские CLI и nvm без ссылок](server-binary-path.md)
- [Движок поставки и физические профили одиночного ELF](server-binary-factory.md)
- [Factory helpers: metadata моделей, статусный протокол и engine-пути от runtimeRoot](server-binary-factory-helpers.md)
- [Host hooks DeepSeek и GLM в payload](server-binary-hooks.md)
- [Guard данных и внешние команды payload](server-binary-placement.md)
- [CJS payload и ленивый запуск приложения](server-binary-entry.md)
- [Ресурсы payload, grigdesk-connect-project и пути установки](server-binary-paths.md)
- [Кэш payload: marker, leases/pins, продолжение попытки и ручной GC](server-binary-cache.md)
- [Лишний `__pycache__` в поколении ломает prepare и установку окна; источник — юниты конвейера](stray-pycache-in-package.md)
- [Контракт metadata и CLI автономного сервера](server-binary-contract.md)
- [Внешний DeepSeek: опись SEA, обычный Node Factory и граница исходников](sea-deepseek-boundary.md)
- [Привязка полного приложения: строка, QR, срок и повтор потерянного ответа](device-pairing.md)
- [Версия контрактов API: заголовок ответов, отпечаток и сторож после первого выпуска](api-version.md)
- [Отпечаток контрактов, переменные хоста, опись helpers и VERSION source-entry](source-metadata-checks.md)
- [Субъект устройства: реестр TLS-сокетов, приоритет авторизации и отзыв](client-device-principal.md)
- [Клиентский TLS-вход: явная настройка, scope, лимиты и изоляция отказов](client-listener.md)
- [Переход на GrigDesk: подготовка, brandMove, журнал, откат и второй этап](brand-migration.md)
- [Node SEA: готовый Linux-комплект, проверка, данные и ручной выбор версии](node-sea.md)
- [SEA и единое приложение: труба UI, TLS-вход, устройства и общий модал настроек](sea-unified-client.md)
- [Сборка ESM-помощников: контекст, явный вход, self-fork и worker ветки в CJS payload](sea-helpers.md)
- [Состав серверного комплекта: ресурсы и PTY входа, production npm, native ABI и лицензии](sea-package.md)
- [Выпуск серверного SEA: сборка, manifest, атомарная публикация и проверка архива](sea-release.md)
- [Обновление SEA-пакета: manifest status, ранние отказы и отделение source updater](sea-update-mode.md)
- [Окно с SEA-сервером: descriptor v3, выбор пакета, профили и возврат](sea-desktop.md)
- [Запуск SEA и регистрация службы: свой Node, unit, окружение и проверки на заглушках](sea-launch.md)
- [Окружение SEA и проверка: пользовательский PATH, Python/npm и быстрый либо полный режим](sea-runtime-checks.md)
- [Изолированная SEA-приёмка: закрытый checkout, host Node stub, read-only R и перенос](sea-isolation.md)
- [Отдельная приёмка SEA: сборка, полный slow gate, npm cache и коды отказа](sea-release-gate.md)
- [Зависимости SEA от хоста: системные библиотеки, Python, CLI и дополнительные runtime](sea-host-requirements.md)
- [Минимум системы: glibc 2.28 у собранных ELF и libfuse.so.2 у AppImage окна](binary-host-minimum.md)
- [Единая папка данных: раскладка, перенос, ранний старт и блокировка](data-home.md)
- [Сервер только API: встроенный интерфейс, снимки и страницы плагинов](api-only-server.md)
- [Дочерний сервер приложения: владение по IPC, код 75, обновление и контроллер запуска](desktop-owned-server.md)
- [Доступ приложения: ключ, сессии, восстановление и авторизованная dev-проверка](desktop-only-access.md)
- [Единая команда: окно, сервер, посредник, статус и защита хода агента](grigdesk-cli.md)
- [Локальный доступ: один HTTP-сокет и вход по ключу](loopback-access.md)
- [Удалённый доступ прежнего приложения через посредника](../mobile/architecture.md) —
  основной HTTP и мобильный вход v1 остаются на loopback; клиентский TLS-вход включается отдельно.
- [Отказ отдельного мобильного TLS-входа не мешает запуску основного GrigDesk](mobile-startup-isolation.md)
- [Авторизация и CLI-токен](authentication-and-cli-token.md)
- [Ключ локального окна: атомарная публикация после listen и обмен на сессию](window-key.md)
- [Программная правка .env — только через общий писатель lib/envFile.ts](env-file-writer.md)
- [Установка и откат DeepSeek ELF: staged verify, receipt, резервирование и память](deepseek-binary-install.md)
- [Обновление GrigDesk с независимым ELF: contract 2, readiness и сохранение runtime](deepseek-binary-update.md)

## Грабли

- [Зависший TCP DNS удерживает process.exit: нативный стек, повторение и границы диагноза](shutdown-dns-threadpool.md)
- [Версия продукта не закрепляется в host-скрипте: формат stable/dev и совместимость ELF](runtime-env-version-sync.md)
- [Плоская папка бинарников: descriptor окна, корень установки, deploy и JSON](portable-binary-layout.md)
- [Постоянный виртуальный вход helper исключает случайный путь staging из бандла](sea-helper-staging-comments.md)
- [«Встал агент», «упал прогон», «нет лимитов» — один корень: подсеть docker поверх VPN](docker-vpn-subnet-conflict.md)
- [Ворота VPN: маршрут, общий черновик и сохранение через «Применить»](vpn-route-check.md)
- [Вход в GrigDesk: один пользователь, сессионная cookie, гард на ВЕСЬ /api](session-authentication.md)
- [Владельцы порта и сокета браузера: служба, ручной запуск, приложение и зависшая остановка](server-port-ownership.md)
- [Браузерный удалённый доступ снят; приложение использует отдельный туннель](remote-access-options.md)
- [Машинные переменные — .env в папке данных, общий для всех способов запуска](machine-environment.md)
- [Первичная настройка пароля снята](local-password-bootstrap.md)
- [Сервер — host-native, не контейнеризуется](host-native-runtime.md)
- [StartLimitIntervalSec=0 в юните GrigDesk — не украшение](systemd-start-limit.md)
- [Старт модуля не ждёт тяжёлых проб: лимит Fastify на плагин](plugin-start-timeout.md)
- [Повторный deploy/install.sh без флага включает автозапуск обратно](install-resets-autostart.md)
- [`node --watch` теряет импорт, на котором упал, и не поднимается после исправления](node-watch-lost-import.md)

## История решений

- [История: Исторический embedded переход DeepSeek: публикация и восстановление](deepseek-release-transition.md)

- [Обычная установка, подписанный v2, внешний worker, применение до обычного Stop и восстановление](installed-release-updates.md)
