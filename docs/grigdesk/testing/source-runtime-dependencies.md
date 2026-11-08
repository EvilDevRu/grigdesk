# Подготовленные зависимости source-проверок GLM

Шесть source-наборов `tests/server/glm-{admission,factory-turn,factory-policy,profile,
vendor-build,vendored-profile}.test.js` и SEA `runtime-probe.test.mts`/`bootstrap.test.mts` получают dependencies
через `testDeepSeekRuntimeDependencies()` из `tests/helpers/deepseekBinary.mts`.
Binary candidate использует тот же helper. Выбор cache общий:

1. Явный `GRIGDESK_DEEPSEEK_NODE_CACHE` имеет приоритет.
2. Иначе берётся `<deepSeekTestArtifactsRoot()>/node-cache`.
3. Корень артефактов — `GRIGDESK_TEST_DEEPSEEK_ROOT`, иначе
   `<artifactsPath()>/deepseek-binary`.

Dependencies находятся в `<cache>/runtime-deps-node24`, пакеты — в его `node_modules`.
Соседний `<cache>/node-runtime/bin/node` — подготовленный pinned worker.
Bootstrap берёт закреплённый архив Node из того же cache, используя `nodeArchive(pin)`.
Папка `tracker/.cache` не является общим тестовым prefix и на чистом CI может отсутствовать.
Обычная подготовка без `--node-cache-dir` использует `deepseek/.cache`, поэтому для
тестов нужно явно указать cache, который выберет helper:

```bash
export GRIGDESK_DEEPSEEK_NODE_CACHE=/absolute/test-artifacts/node-cache
npm --prefix deepseek run prepare:runtime -- --node-cache-dir "$GRIGDESK_DEEPSEEK_NODE_CACHE"
```

`readPreparedRuntimeDependencies()` проверяет stamp: версию и SHA256 архива из Node pin,
SHA256 executable, строковый ABI, хеши и точные байты manifest/lock, наличие manifests
TypeScript и esbuild. Отсутствующая или повреждённая подготовка завершает тест ошибкой
«Подготовьте dependencies pinned Node» с командой и выбранным cache. Тесты не делают skip,
не запускают npm или загрузку и не берут зависимости из `server/node_modules`.
Это существующая проверка готовности prefix, а не полный хеш каждого установленного пакета.

YAML читается через `runtimeYaml(dependencies.directory)`: его схема сохраняет upstream
`!!js` как данные. Closure и composition получают тот же prefix, license-проверка копирует
его `node_modules`. Чтение YAML и сканирование лицензий не исполняют native addons pinned
Node под ABI текущего Node тестового процесса. Exact pi-ai, dependency closure и все
защитные assertions GLM сохраняются.

SEA runtime-probe хэширует выбранный подготовленный `node_modules` до и после запуска
изолированного ELF, проверяет ACP/web, worker ABI и native helpers. Доказательства называются
`prepared-deps-before.sha256`, `prepared-deps-after.sha256`; transport proof содержит
`preparedDependenciesUnchanged`. Прежний `deepseek/build/runtime-deps/node_modules` не нужен.

Для настоящего candidate отдельно нужен проверенный snapshot Harness: порядок его явной
подготовки описан в [README пакета](../../../deepseek/README.md).
Standalone legacy builder сохраняет собственный prefix и ABI-контракт; эта подготовка
его не заполняет. Только миграционный test helper
[автоматически готовит отдельный prefix текущего Node](deepseek-legacy-preflight.md).
Остальные гейты описаны в [карте DeepSeek-проверок](deepseek-test-gates.md).
