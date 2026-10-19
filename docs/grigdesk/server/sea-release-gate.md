# Серверный SEA в проверке релиза

`bash tools/server-sea-check <out-dir> <cache-dir>` выполняет `build:sea`, читает
`build-result.json` и передаёт полученный каталог всей команде `test:sea`.
Пробелы в пути сохраняются. Относительные пути разрешаются до запуска npm;
ошибка сборки останавливает проверку с её кодом выхода.

Без аргументов helper использует `GRIGDESK_SEA_RELEASE_DIR` и
`GRIGDESK_SEA_CACHE_DIR`, а для незаданных путей создаёт отдельный каталог в tmp.
Результат остаётся для осмотра. `npm_config_cache` имеет приоритет; иначе общий
для сборки и dependency probe кэш находится в `<cache-dir>/npm`.
Требуемый архив Node должен быть подготовлен заранее, как описано в
[контракте сборки](sea-release.md).

`GRIGDESK_SERVER_RELEASE_DIR` передаёт выбранный R тестам; `test:sea` устанавливает
его из `--release-dir`. Shell-массив `GRIGDESK_SERVER_COMMAND` собирает argv ручного
запуска внутри runtime-env. Эти два имени и оба SEA каталога входят в общий
`HOST_ENV_SUFFIXES` модуля совместимости; соответствие ключам исходников держит
`tests/server/brand-env.test.mts`. Внутренний массив argv заполняет launcher.

SEA собирается и принимается только явным запуском этого helper-а либо двумя
npm-командами из [контракта сборки](sea-release.md). Обычные `tools/release-check`
и `tools/release` сохраняют прежний путь выпуска: не вызывают SEA, не требуют его
архива Node и production npm staging. Сам helper ничего не устанавливает, не создаёт
тегов и не публикует. Подмена `GRIGDESK_RELEASE_CHECK_COMMAND` остаётся портом
существующих тестов обычного release-скрипта.

`test:sea` находит все `tests/server/sea/*.test.mts` и передаёт их memory guard
с concurrency1. Отсутствующий release или пустой набор тестов дают отказ;
код сторожа сохраняется. Этот тяжёлый набор отделён от быстрых server tests.
Настоящие systemd/GUI `.e2e.mts` запускаются владельцем отдельно.

Поведение явного helper и отсутствие SEA в обычном preflight проверяют
`tests/server/sea-release-check.test.js` на отдельных портах git/npm.
`tests/server/sea-test-runner.test.js` проверяет реальный argv memory guard,
выбор всего slow набора и перенос кода7 без запуска тяжёлой сборки.
