# URL модуля при запуске окна CommonJS

`desktop/scripts/build.mts` собирает главный процесс Electron в `main.cjs`. Импортируемые
серверные CLI-модули проверяют `isDirectRun(import.meta.url)` ещё при загрузке бандла.
Обычная сборка CommonJS теряет `import.meta.url`: при непустом `process.argv[1]` проверка
падает в `fileURLToPath(undefined)` до создания первого окна.

Сборка задаёт `import.meta.url` через esbuild `define`, а `banner` вычисляет значение как
`require('node:url').pathToFileURL(__filename).href`. URL относится к конечному `main.cjs`,
поэтому сохраняет смысл после перемещения staging и при пробелах в пути. При запуске
`electron <каталог приложения>` CLI-проверка возвращает `false`; импорт не запускает CLI.
Серверные исходники и предпочтения безопасности окон при этом не меняются.

Изолированная исходная сборка для Electron E2E должна использовать те же `define` и `banner`.
Проверки: `tests/desktop/build-contract.test.js`, `tests/desktop/e2e/task-window.e2e.mjs`.
