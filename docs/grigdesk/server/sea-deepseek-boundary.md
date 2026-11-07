# DeepSeek на границе исходников и серверного SEA

Здесь сохранён контракт прежнего R и перехода; граница внешнего DeepSeek действует
и в payload. Его раскладка и launcher описаны в [обзоре одиночного ELF](server-binary.md).

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
| `server/src/lib/deepseek/distribution.ts`: runtimeInstallationBin | Входит в server bundle. Fallback выбирает внешний `I/bin/deepseek`; source сохраняет свой bin. |
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

## Ход чата на настоящем SEA блокируется

Проверено 20.10.2026 на комплекте из dev с установленным `bin/deepseek` и записанным допуском GLM.
Каталог объявляет DeepSeek и GLM доступными, но первый же ход DeepSeek кончается ошибкой
«Ход DeepSeek заблокирован»: DSH завершает его с `reason.kind = 'blocked'`. Причина в hooks
профиля. `lib/deepseek/profile.ts` и `lib/glm/profile.ts` собирают команду hook из
`process.execPath` и пути `server/scripts/deepseekInstructionsHook.mts` или
`glmToolPolicyHook.mts` рядом с модулем. В SEA `process.execPath` — сам `grigdesk-server`,
а `server/scripts` в комплект не входит. Hook не запускается, маркер не появляется, и DSH
блокирует ход. Эти точки в описи помечены `deferred-deepseek`. Нынешний исходный код уже собирает эти hooks как helpers и выбирает явный Node в packaged
profiles. Маленькая compiled fixture подтверждает их исполнение, включая отказ прямого SSH;
это исправление требует новой сборки сервера и не меняет уже работающий комплект.
