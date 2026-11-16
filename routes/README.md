# CLI routes

Отдельный TypeScript-пакет авторинга маршрутов GrigDesk. Команды работают через
локальный авторизованный API; коды ошибок и подтверждение публикации сохраняются.
[Полный контракт и примеры](../docs/grigdesk/pipeline/routes-cli.md).

- `npm --prefix routes run start -- --help` — запуск из исходников.
- `npm --prefix routes test` — строгие типы и профильные тесты через сторож памяти.
- `npm --prefix routes run build` — самостоятельный ELF `bin/routes`, вне git.
- `npm --prefix routes run test:sea` — отдельная проверка готового SEA.

Для сборки нужны devDependencies этого пакета. Закреплённый архив Node проверяется
по SHA256 из build/node-runtime.json; кэш — routes/.cache/. Общий SEA-протокол находится
в shared/node/cliSeaBuild.ts и не зависит от tracker/. Готовому ELF системный Node не нужен.
