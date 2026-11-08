# Общий код в фикстуре чистой установки

Тест `tests/server/deepseek-runtime-packaging.test.js` создаёт отдельный checkout
для настоящей подготовки runtime. Он копирует `tools/`, `shared/`, scripts/build/host
пакета DeepSeek, manifest, патчи, лицензии и нужные серверные точки входа.
Кэш `upstream/`, `node_modules` и собранный
runtime в исходную фикстуру не входят.

Серверная часть fixture включает import closure runtime resolver: `binaryProbe.ts`,
`distribution.ts` и `server/deepseek-host-contract.json` вместе с artifact/process
модулями. Отсутствие любого из них ломает prepare до сборки; добавление этих исходников
сохраняет запрет переносить готовый runtime или зависимости в clean checkout.

`tests/server/helpers/sourceRuntimeFiles.mts` хранит общий минимальный список
`runtimePaths.ts`, `runtimeBuildContext.ts` и импортируемый `shared/node/bundleLayout.ts`.
Их переносят readiness, Docker, mobile
и desktop installer: `distribution.ts` и ранний data-home guard используют эти модули
даже без установленного ELF. Отсутствие модулей даёт ERR_MODULE_NOT_FOUND до проверяемой
команды; фикстура чистого checkout должна включать всю эту границу импорта.

Серверный installer-fixture копирует `deploy/lib/tracker-cli.sh` и моделирует
`tracker/` → `bin/tracker` → ссылку в PATH. Прежних `b24-cli.sh` и папки `b24/`
в исходной установке нет. Фикстуры арбитра включают журнал `operations`, а launch
проверяет `--queue-dispatch-id` между hash каталога и `--routes-dir`, сохраняя проверку
явного `--runner-primary`.

Снимок `DATA_LAYOUT` в `data-home.test.mts` проверяет действующую раскладку GrigDesk.
Прежние `factory`, `factoryState`, `factoryControl`, `factoryConfig`, `factoryRoutes`
и `factoryAnalysis` не входят в этот реестр: пути внешнего движка задаются отдельно.

После выноса хеша `deepseek/scripts/deepseekVendorManifest.ts` импортирует `shared/node/hash.ts`.
Если копировать только инструменты, подготовка завершается `ERR_MODULE_NOT_FOUND`
до проверки установки. Фикстура должна переносить общий исходный слой целиком,
как настоящий checkout, сохраняя ограничения на кэш и зависимости.

Проверка остаётся поведенческой: подготовка в production, повторное использование
того же buildId, recovery и запуск перенесённого поколения без build-зависимостей.

Та же граница действует в `tests/b24/cli.test.mts`: сценарий BI-10 переносит исходники
b24 в путь с пробелами и запускает их из разных cwd. Он копирует весь `shared/`,
поскольку main использует `shared/node/files.ts` наряду с runtime-настройками.
Копирование только прежних отдельных runtime-файлов теряет зависимость до HTTP-запроса.

Фикстура `mobile-build-script.test.js` переносит также `tools/mobile-client.mts`, общий
сборщик `client-ui.mts`, `desktop/src/uiRelease.ts`, `desktop/src/locale.ts` и его зависимости
из shared, включая целиком `shared/i18n/` с каталогами переводов. Подменённый
npm создаёт index.html в переданном staging outDir, Gradle — APK модуля :client. Это сохраняет
проверку настоящего sealing и публикации файла, не вызывая внешние компиляторы.

Снимки чистого checkout используют текущие имена и контракты: standalone `tracker`,
профили из source `profiles/`, новый manifest плагина с `entrypoints`/`contributes`,
v2-индекс руководства и общий профиль памяти 4096 МиБ с concurrency=2.
Подписывающая фикстура задаёт собственное build-окружение: версия dev-выпуска CI не должна
заменять её явно записанную стабильную VERSION.

В проверках отсутствующего внешнего Node/npm PATH ограничен собственным bin.
Системный Node runner допустим для обычной Bash-пробы, но наличие серверного nvm/bin
в PATH не доказывает его выбор внешней оболочкой. MCP-фикстура сохраняет настоящий reader,
подменяя также отдельную capability-пробу scopedWorkspace, которая требует metadata CLI.

Собранный GLM hook проверяется в ACP-профиле: web-профиль использует native gate и
намеренно удаляет прежний policy hook из UserPromptSubmit. Fake web DeepSeek объявляет
обязательную capability toolPermissions. Dynamic tools Codex проверяются в доступном Auto;
отключённые профили не должны молча подменяться доступным режимом.

Серверный ACK запуска конвейера имеет outcome `started`; наличие тикета и его Telegram-секция
проверяются после этого ответа. Проба настоящего speech supervisor ожидает терминальное
состояние по deadline 15 секунд, отдельно от быстрого fake runner.
