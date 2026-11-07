# Синхронный ранний импорт папки данных

`server/src/startDataHome.ts` выполняет preflight до загрузки конфигурации сервера.
Его side-effect import стоит первым в `server/src/app.ts`, раньше help и остальных
сервисов: их транзитивные зависимости также могут читать config. Ранний граф остаётся
синхронным: проверка папки данных не должна начинать поиск CLI, ждать асинхронную
файловую операцию или менять порядок запуска dotenv и config.

`shared/node/packagedEnvironment.ts` использует чистый `cliPathOrder.ts`. Он только
упорядочивает уже переданные каталоги PATH. `userCliPaths.ts` содержит отдельный поиск
каталогов и сохраняет совместимый экспорт `userCliPath`; ранний граф через него не проходит.
Поиск вызывается при подготовке packaged-запуска там, где нужны найденные CLI.

`shared/node/bundleLayout.ts` содержит синхронные marker/receipt readers для определения
корня установки до config. Асинхронный поиск AppImage вынесен в
`shared/node/portableWindowPath.ts`; его вызывает desktop portable runtime, а ранний
серверный граф этот модуль не импортирует.

DB-07 в `tests/server/data-home-boot.test.mts` проверяет первый import и весь ранний граф
без исключений.
Порядок PATH, фильтрация и поиск nvm закреплены `server-binary-cli-path.test.js`.
