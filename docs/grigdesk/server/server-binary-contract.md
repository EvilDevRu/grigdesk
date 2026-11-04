# Контракт автономного серверного пакета

`shared/runtime/serverBinary.ts` декодирует публичный runtime-info: format 1,
hostContract 1, продуктовая версия в стабильном SemVer, packagingVersion 2, Linux x64, Node 24.21.0 / ABI 137.
Обязательны возможности api, ipc, helpers и engine; приватный индекс не выводится.

`server/src/binary/metadata.ts` вычисляет packageId как SHA256 канонического полного
manifest, исключая только верхнее поле packageId. Launcher и payload входят в identity.
Декодер публичной проекции не проверяет SHA урезанной проекции.

Чистый `server/src/binary/args.ts` закрывает таблицу режимов до доступа к окружению и FS.
Повторы и несовместимые флаги отвергаются. Prepare требует --json, а его совместимый
alias --check-startup подразумевает JSON. Передача preparation-token разрешена только
запуску с expect-package-id; release требует token, package-id и --json.
Реализация parser сама не запускает сервер и не создаёт кэш.

Продуктовая версия manifest берётся сборщиком из корневого `VERSION`, входит в packageId
и проверяется также в защищённой identity payload. Format и hostContract при изменении
продуктовой версии сохраняются; префиксы, ведущие нули и суффиксы версии запрещены.
