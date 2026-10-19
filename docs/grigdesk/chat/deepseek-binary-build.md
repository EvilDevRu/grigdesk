# Сборка автономного DeepSeek

[README пакета](../../../deepseek/README.md) содержит полный порядок чистого checkout.

Пакет `deepseek/` выпускает Linux x64 ELF с закреплённым Node из
`deepseek/build/node-runtime.json`. Сборщик не импортирует сервер. Готовый файл включает
launcher, обычный worker Node, generation Harness, bootstrap, verifier и лицензии; при запуске
ему не нужны исходники, npm, системный Node или соседние файлы.

```bash
npm ci --include=dev --prefix deepseek
npm --prefix deepseek run prepare:runtime
# Подготовка source snapshot — отдельный явный шаг, см. README пакета.
npm --prefix deepseek run build -- --out-dir /absolute/output
npm --prefix deepseek run verify -- --binary /absolute/output/deepseek
```

`prepare:runtime` — явный шаг: устанавливает exact runtime lock собственным pinned Node в
`deepseek/.cache/runtime-deps-node24/`. Legacy зависимости в `deepseek/build/runtime-deps/`
не перезаписываются. Нативная сборка использует полную установку pinned Node с development
headers; bytes упаковываемого executable сверяются с ней по SHA256.
Бинарная generation строится с `--read-only`: modes 0444/0555 входят в её payload hashes
и buildId. Каталоги принадлежат владельцу и имеют права 0700.

`--node-cache-dir` подготовки и сборки разрешается от cwd и меняет только build cache.
Рабочий `--cache-dir` ELF — другой аргумент: он требует абсолютный путь. По умолчанию сборка
публикует `bin/deepseek`; тесты передают отдельный output в артефактах. Отказ любой стадии,
включая smoke, сохраняет прежний output. Публикация — atomic rename после runtime-info и
полного `--verify` новым ELF.

Для переупаковки прежней generation используются `--binary-version <version>` и
`--payload <payload.zip>`. Рядом с ZIP обязателен build-sidecar `payload.zip.manifest.json`:
он содержит полный индекс modes, symlinks и SHA256. Сборщик проверяет его packageId и весь
архив. Оба файла сохраняются в `payloads/<sha256>/` build cache. Они нужны сборщику;
установленный ELF включает эти данные внутрь. Изменение версии поставки сохраняет buildId
и GLM compatibility, меняя packageId и bytes ELF.

В SEA manifest хранится в каноническом JSON без поля packageId. Отдельный asset содержит
SHA256 этих bytes; launcher сверяет его перед разбором JSON. Канонизация выполняется
при сборке, а публичное runtime-info и build-sidecar по-прежнему содержат packageId.
Полный индекс payload проверяет materializePayload до создания каталогов и lock.

`npm --prefix deepseek test` запускает быстрые тесты, `test:sea` — настоящие ELF последовательно.
Оба используют сторож памяти. Test helper собирает candidate из приватной копии пакета и shared,
удаляет её перед проверками и держит один прогретый cache для A/B. Зависимости и архив Node
нужно подготовить явно в `<artifacts>/deepseek-binary/node-cache/`; helper не загружает их
скрыто. Явный `GRIGDESK_TEST_DEEPSEEK_BINARY` тоже проходит metadata и полный verify.

Launcher с `execArgvExtension: none` не исполняет `NODE_OPTIONS` require/import. Запрещённый
`NODE_REPL_EXTERNAL_MODULE` отвергается самим pinned Node до JS с кодом 9. Worker удаляет
loader inputs; `NODE_V8_COVERAGE` получает пустое значение, поскольку child_process иначе
автоматически переносит родительское значение даже поверх явного списка env. Собственная
instrumentation SEA может писать в явно заданный вызывающим процессом cache/coverage.
