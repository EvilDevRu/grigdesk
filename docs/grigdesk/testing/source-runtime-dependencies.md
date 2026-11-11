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

## Retention тестовых артефактов

`ensureTestDeepSeekBinary()` перед build/metadata/verify выполняет уборку под существующим
directory lock. Это общий участок для обычного candidate и explicit binary. Само чтение
`testDeepSeekRuntimeDependencies()` ничего не убирает и не устанавливает.

Порог `GRIGDESK_TEST_DEEPSEEK_RETENTION` имеет синтаксис положительного целого с `m|h|d`,
по умолчанию `7d`. `GRIGDESK_TEST_DEEPSEEK_KEEP_GENERATIONS` — положительное безопасное
целое, по умолчанию `3`. Defaults и валидаторы общие с `grigdesk-ctl artifacts-cleanup`;
неверная настройка останавливает подготовку до удаления и запуска binary.

В выбранном тестовом root убираются дочерние каталоги `test-builds`, `explicit-cache`,
только `candidate-*`/`reports-*` в `gates`, только `standalone-*` в `build-input-tests`,
а также старые поколения вне последних K в `node-cache/generations`. Незнакомые семейства
и остальные темы артефактов не выбираются. Архив Node, payloads, runtime-deps и node-runtime
сохраняются. Выбранный `GRIGDESK_DEEPSEEK_NODE_CACHE` никогда не становится объектом retention,
в том числе если его физический путь попадает внутрь `explicit-cache` или другого
выбираемого семейства. Защищаются как заданный путь, так и разрешённая цель symlink.

Текущий каталог внутри root освежается и защищается под собственным sibling lock; lock
остаётся до конца metadata/verify/build. Заведомо текущий каталог пропускается до полного
обхода и получает `bytes: null`. Для внешнего explicit cache удерживается только
lock тестового root: внешний cache не получает sidecar и не меняет mtime. Явные binary
и payload также защищены. Чужие живые и неизвестные lock-и сохраняются, в том числе
`.locks/<packageId>` и `generations/<id>.lock`. При чужой активной сборке темы поколения
сохраняются целиком. На время удаления общий барьер запрещает выдачу новых directory lock
внутри выбранного root и для самого root; ранее выданные lock-и защищают свои деревья.
Builder удерживает generation lock до конца упаковки, включая чтение journal contract.
Свежесть соседних поколений измеряется одним общим проходом; перед удалением заново
проверяется только сам кандидат и состав поколения, см. [контракт](../server/artifacts-cleanup.md).

Об удалённых каталогах и байтах helper сообщает только в stderr; stdout CLI остаётся одним
JSON candidate. Ошибка уборки видна в stderr и отклоняет Promise, lock снимается в finally.
Никаких скрытых npm/Node preparations, ctl-подпроцессов или фонового таймера нет.

Изолированные проверки: `tests/deepseek/helper-retention.test.mts` и
`helper-retention-barrier.test.mts`. Они используют приватные корни и executable-double,
настоящие filesystem и directory lock, без сборки ELF и обращения к живым данным.
`tests/cli/artifacts-cleanup-races.test.mts` проверяет оба порядка гонки выдачи lock,
физические пути через symlink, восстановление барьера и линейное число полных обходов.
Дополнительные `artifacts-cleanup-{paths,safety}.test.mts` проверяют fd/quarantine,
install-lock, брошенные sidecar и current; `artifacts-cancellation.test.mts` — отмену
preview/удаления в настоящем PTY и частичный JSON. `helper-retention-paths.test.mts`
проверяет source-ветку с cache override внутри своего семейства без настоящей сборки ELF.
`tests/deepseek/payload-retention.test.mts` проверяет реальный generation lock в builder
на фазах package/journal: конкурирующий acquire занят, уборка сохраняет поколение вне K,
обе ошибки снимают lease. Readiness/identity и payload заменены двойниками, ELF не собирается.
