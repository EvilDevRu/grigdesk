# Сервер и доступ

- [Профили доступа исполнителей: приватные ревизии, восстановление и сохранение прежнего .env](../chat/access-profile-rules.md)

Читай при изменении запуска, установки, доступа, поставки и конфигурации сервера.

Запуск и юнит, авторизация, переменные машины, сеть.

Схема приложения и двух входов описана в [устройстве единого приложения](../overview/unified-client.md).

Читай перед правкой: `server/src/app.ts`, `server/src/plugins`, `server/src/modules/auth`, `bin`, `deploy`.

## Устройство

- [Серверные области каталога проектов и явное чтение архива](../overview/projects-api.md#жизненный-цикл)
- [Серверное задание relay: общий API, выбор и отмена ожидания, SSH, порт и возобновление VPS](relay-setup.md)

- [Остановка до выхода ОС: независимые сторожа worker, потеря launcher, код 75 и поэтапный журнал](shutdown-watchdogs.md)
- [Изоляция исходящих интеграций: буферизованный HTTP, DNS для потоков и восстановление](isolated-statistics-fetch.md)
- [Предел попыток happy-eyeballs: переключение между IPv4 и IPv6 в сервере и Harness](network-family-attempt-timeout.md)
- [Ротация stdout/stderr, gzip-архивы и чтение всех частей журнала окна](log-rotation.md)
- [Времена HTTP, ожидания, цикл событий, CPU и GC](runtime-performance.md)
- [Единый режим допуска GLM при установке сервера и DeepSeek](server-install-glm-mode.md)
- [Условная правка .env: сверка прежнего значения под очередью писателя](env-file-expected-value.md)
- [Исходный PATH/prefix и приватная проверка Bash для внешних CLI](user-cli-parent-environment.md)
- [Подтверждение TLS-привязки, готовность relay и диагностика отказов](phone-pairing-confirmation.md)
- [Управляемый direct-вход, PHONE:2 и общий client relay](phone-access.md)
- [Первый импорт папки данных, синхронный граф и отдельный поиск CLI/AppImage](early-data-home-imports.md)
- [Shell-установщик, офлайн-ZIP и .deb для Linux x64, кандидат Apple Silicon и доверие dist](lightweight-installer.md)
- [Локальная сборка Windows x64 из Linux, офлайн-установка Windows x64 и ARM64 и приёмка](windows-offline-installation.md)
- [Darwin, владение задачами, flock при системном PATH, закрепление runtime и допуск обновления](darwin-process-identity.md)
- [История автономного установщика: потоковый хвост архивов, ограничение postject и проверка ELF](installer-archive-tail.md)
- [Подписанный канал сайта, защита от отката, офлайн-приёмка и справка RU/EN](site-release-channel.md)
- [Ручной выбор full/skip, причина, identity и запись решения в выпуске](release-test-selection.md)
- [Release workflow, нативные сборщики, общая выгрузка девяти файлов и допуск promote](release-workflow-validation.md)
- [Stable из проверенных исходников: полный run, проверка пакетов и сверка Git-дерева](release-validation-reuse.md)
- [Фоновый реестр исполнителей: бюджет 1,2 с, сохранение карточек при переименовании, wait и refresh](providers-background-read.md)
- [Сборка на экране меню, отмена, итог и полный журнал](cli-build-interaction.md)
- [Пустой вызов CLI: меню или справка, открытие окна только по явному действию](cli-default-command.md)
- [Терминальное меню CLI: цели дистрибутива, папка dists, блокировка платформ и уборка](cli-terminal-menu.md)
- [Инвентаризация артефактов, ручная уборка, защита папок запусков и кэша Node](artifacts-cleanup.md)
- [Оформление Go-меню: тёмная палитра, подменю, адаптация к размеру](cli-menu-rendering.md)
- [Общие экраны консоли: выбор, подтверждение, скрытый ввод и прогресс](cli-terminal-screens.md)
- [Переносимая папка: свежая сборка, архив, первый запуск и меню](portable-bundle.md)
- [Каталог плагинов: автоматический выбор сайта и закрытый локальный API](../plugins/plugin-marketplace.md)
- [Сборка из исходников: Go-утилиты, подготовка dev-зависимостей окна, события fd 3 и CLI](ctl-build.md)
- [Android APK в меню сборки и отдельной команде, папка dists и ошибки](ctl-build-apk.md)
- [Полная сборка привязывает окно к новому серверу при следующем запуске](build-server-selection.md)
- [E0 без baseline: функциональные ворота, cold-порог и приватный HOME независимо от umask](server-binary-smoke-baseline.md)
- [Выбор ELF/R/source и владение preparation в окне](server-binary-desktop.md)
- [Сервер одним ELF: I/D/R, argv, launcher, приёмка и действия владельца](server-binary.md)
- [Установка, private receipt и откат серверного ELF](server-binary-install.md)
- [Пересборка проверяет совместимость сервера с установленными DeepSeek/GLM до замены](server-executor-install-guard.md)
- [PATH одиночного ELF: пользовательские CLI и nvm без ссылок](server-binary-path.md)
- [Go-фабрика, перепривязка попыток, сборка и владение процессами Windows](server-binary-factory.md)
- [Factory helpers: metadata, внешние npm-зависимости, writer закреплённого запуска и редактор](server-binary-factory-helpers.md)
- [Host hooks DeepSeek и GLM в payload](server-binary-hooks.md)
- [Guard данных и внешние команды payload](server-binary-placement.md)
- [CJS payload и ленивый запуск приложения](server-binary-entry.md)
- [Ресурсы payload, grigdesk-connect-project и пути установки](server-binary-paths.md)
- [Кэш payload: marker, leases/pins, продолжение попытки и ручной GC](server-binary-cache.md)
- [Лишний `__pycache__` в поколении ломает prepare и установку окна; источник — юниты конвейера](stray-pycache-in-package.md)
- [Контракт metadata и CLI автономного сервера](server-binary-contract.md)
- [Внешний DeepSeek: опись SEA, обычный Node Factory и граница исходников](sea-deepseek-boundary.md)
- [Привязка полного приложения: строка, QR, срок и повтор потерянного ответа](device-pairing.md)
- [Версия API: заголовок, актуальный отпечаток 0.2.0 и независимый сторож](api-version.md)
- [Отпечаток контрактов, переменные хоста, опись helpers и VERSION source-entry](source-metadata-checks.md)
- [Субъект устройства: реестр TLS-сокетов, приоритет авторизации и отзыв](client-device-principal.md)
- [Клиентский TLS-вход: явная настройка, scope, лимиты и изоляция отказов](client-listener.md)
- [Переход на GrigDesk: подготовка, brandMove, журнал, откат и второй этап](brand-migration.md)
- [Node SEA: готовый Linux-комплект, проверка, данные и ручной выбор версии](node-sea.md)
- [SEA и единое приложение: труба UI, TLS-вход, устройства и общий модал настроек](sea-unified-client.md)
- [Сборка ESM-помощников: контекст, self-fork, worker ветки, медиа Qwen и Showcase](sea-helpers.md)
- [Состав серверного комплекта: ресурсы и PTY входа, production npm, native ABI и лицензии](sea-package.md)
- [Выпуск серверного SEA: Go-утилиты, manifest, атомарная публикация и проверка архива](sea-release.md)
- [Обновление SEA-пакета: manifest status, ранние отказы и отделение source updater](sea-update-mode.md)
- [Окно с SEA-сервером: descriptor v3, выбор пакета, профили и возврат](sea-desktop.md)
- [Запуск SEA, фазы LaunchAgent, проверка владельца перед остановкой](sea-launch.md)
- [Окружение SEA и проверка: пользовательский PATH, Python/npm и быстрый либо полный режим](sea-runtime-checks.md)
- [Изолированная SEA-приёмка: закрытый checkout, host Node stub, read-only R и перенос](sea-isolation.md)
- [Отдельная приёмка SEA: сборка, полный slow gate, npm cache и коды отказа](sea-release-gate.md)
- [Зависимости SEA от хоста: системные библиотеки, Python, CLI и дополнительные runtime](sea-host-requirements.md)
- [Минимум системы: glibc 2.28 у собранных ELF и libfuse.so.2 у AppImage окна](binary-host-minimum.md)
- [Единая папка данных: раскладка, перенос, Android и временная копия обновлятора](data-home.md)
- [Сервер только API: встроенный интерфейс, снимки и страницы плагинов](api-only-server.md)
- [Дочерний сервер приложения: владение по IPC, код 75, обновление и контроллер запуска](desktop-owned-server.md)
- [Доступ приложения: ключ, сессии, восстановление и авторизованная dev-проверка](desktop-only-access.md)
- [Единая команда: окно, сервер, статус связей посредников и защита хода агента](grigdesk-cli.md)
- [Локальный доступ: один HTTP-сокет и вход по ключу](loopback-access.md)
- [Удалённый доступ через посредника и его wire-протокол](../mobile/relay-deploy.md#wire-протокол-посредника) —
  основной HTTP остаётся на loopback; клиентский TLS-вход включается отдельно.
- [Авторизация и CLI-токен](authentication-and-cli-token.md)
- [Ключ локального окна: публикация после listen, UID на Android и обмен на сессию](window-key.md)
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

- [Установка и обновление](installed-release-updates.md) — Go maintenance, владелец AppImage и восстановление handoff
