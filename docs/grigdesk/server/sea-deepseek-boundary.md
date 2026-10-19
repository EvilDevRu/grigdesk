# DeepSeek на границе исходников и серверного SEA

Сервер выбирает автономный внешний ELF через `bin/deepseek` или явный override.
В packaged-режиме конфигурация сразу объявляет `binary`: исходный
`server/deepseek-runtime-contract.json` внутри R не нужен. Harness source и его
legacy generation не входят в серверный комплект.

Опись `server/build/sea-inventory.json` сверяется со штатными `scanProject` и
`checkInventory` из `server/scripts/sea/inventory.mts`. Сканер находит точки и их
число; владелец назначает смысл каждой записи. Добавление строки с произвольной
судьбой не доказывает, что модуль входит в сборку.

| Точка | Судьба и проверка |
| --- | --- |
| `deepseek/distribution.ts`: `import.meta.dirname`, корень `.` | Входит в server bundle. AST-плагин сохраняет виртуальный путь модуля в R; fallback выбирает внешний `R/bin/deepseek`. |
| `deepSeekCandidateGate.ts`: `process.execPath` | Только разработка: source-sync строит и принимает отдельный ELF обычным Node. В серверный SEA этот builder не входит. |
| `grigDeskRelease.ts`: два импорта `binaryReadiness.ts` | Только git-updater исходников. SEA подменяет `releaseServices` на `packagedRelease`; `grigDeskRelease` отсутствует в CJS-графе. |
| `grigdesk-update-worker.js`: `process.execPath` | Только git-updater исходников; серверный SEA не запускает этот worker. |

Существующие `deferred-deepseek` записи host hooks и runner helpers сохраняют свою
границу: их отдельная упаковка не доказывается одним обновлением описи. Проверка
виртуальных путей не объявляет весь транспорт DeepSeek/GLM принятым на реальном SEA.
`sea-runtime-paths.test.js` собирает настоящий ESM через плагины комплекта и проверяет
путь внешнего ELF и обычного Node без source-контракта. `sea-release-build.test.js`
проверяет фактический состав CJS-графа сервера.

Factory берёт Node через `nodeExecutable()`, чтобы `process.execPath` серверного SEA
не стал интерпретатором metadata-helper. Его env фиксирует `binary`, выбранный ELF
и cache поверх extra env. Собственный fallback на `server/runtime/deepseek` снят;
явный legacy root из конфигурации сохраняется только для перехода прежних homes.

Изолированному source-consumer нужны `server/src`, `server/scripts`, общий код,
движок и каталог `server/build/helpers.json`. Каталог описывает ordinary helpers и
не добавляет Harness source или runtime. Это проверяет настоящий ELF-сценарий
`deepseek-boundary.test.js`, сохраняя запрет на эти деревья.
