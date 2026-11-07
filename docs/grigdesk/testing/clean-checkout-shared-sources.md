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
