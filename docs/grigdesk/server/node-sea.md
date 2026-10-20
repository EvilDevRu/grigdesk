# Сервер GrigDesk в Node SEA

Здесь сохранён контракт прежнего каталога R и перехода с исходников.
[Новый сервер одним ELF](server-binary.md) описывает payload, launcher и кэш в папке данных.

Сервер собирается в Linux x64 комплект с главным исполняемым файлом
`R/server/grigdesk-server`. Проверенный runtime — **Node 24.21.0, ABI 137**.
Установка системного Node и checkout для запуска комплекта не нужны.
Исходный способ `node server/src/app.ts` сохраняется.

Это каталог поставки: рядом с SEA лежат собственный Node/npm для помощников,
production npm-зависимости, 18 ESM helpers, ресурсы, движок, b24, relay и лицензии.
Главный сервер — CJS SEA; собственные вычисляемые импорты исполнителей и DB engines
заменяются сгенерированными таблицами. Пользовательские ESM-плагины загружает внешний
bridge, который сохраняет относительные импорты и top-level await.

## Сборка и проверка

```bash
npm --prefix server run build:sea -- --out-dir /path/to/releases --cache-dir /path/to/cache
npm --prefix server run test:sea -- --release-dir /path/to/releases/grigdesk-server-VERSION-linux-x64-CONTENT
```

Обе команды вместе выполняет явный `bash tools/server-sea-check <out-dir> <cache-dir>`.
Обычный выпуск продукта SEA не собирает: [разделение путей выпуска](sea-release-gate.md).

Node берётся из заранее сохранённого архива с проверкой SHA256. Для сборки нужны
devDependencies, tar/xz, Python и инструменты native-сборки; npm использует
`npm_config_cache` либо отдельный cache/npm. Детали:
[состав](sea-package.md), [helpers](sea-helpers.md), [manifest и выпуск](sea-release.md).

`release.json` описывает версию, runtime и все файлы с хешами, режимами и ссылками.
`--check-runtime` проверяет целостность без boot и данных пользователя; `--version --json`
читает версию поставки. `build-result.json` рядом с архивом содержит его SHA256, размер,
contentId и пути. Один хеш не доказывает битовую воспроизводимость SEA.

Проверенный архив запускается в bwrap с недоступным checkout, заглушенным внешним Node
и read-only R. Приёмка проверяет API/auth/SSE/WS/UI, Python PTY, реестры, DB query/cancel,
локальный ход агента с MCP/scope, ESM lifecycle, installer supervisor, GLB, Bash wrappers,
IPC, restart75 и перенос в путь с пробелами. Команда `test:sea` выполняет весь отдельный
SEA-набор через сторож памяти. [Устройство изолированных проверок](sea-isolation.md).
Отдельный набор на закреплённом runtime прошёл **24/24**, без skips; он включает
реальную установку production npm и загрузку двух native bindings после очистки
промежуточной сборки. Отдельный writable R проверяет
работу factory-route/npm из терминала и повторный boot;
[окружение детей и режимы проверки](sea-runtime-checks.md).
Настоящие GUI и systemd E2E запускаются отдельно владельцем; проверки на заглушках
не означают прохождения этих двух внешних сценариев.

## Данные и выбор версии

R не используется для пользовательских данных. Настройки, профили, журналы, модели
и задания лежат в отдельной [папке D](data-home.md) и разрешённых рабочих каталогах.
Внешние CLI моделей, Python, shell, ffmpeg, браузеры и модели речи остаются
host-зависимостями соответствующих возможностей. Комплект не устанавливает их при boot.
ELF использует glibc и системные C/C++ библиотеки: [границы переносимости](sea-host-requirements.md).
DeepSeek runtime в первой поставке отсутствует; адаптер недоступен, основной boot работает.

Обновлённое окно выбирает проверенный комплект командой:

```bash
GRIGDESK_HOME=/data/grigdesk bin/grigdesk-ctl desktop use-server /path/to/release
```

Окно должно быть закрыто, владелец lock — остановлен человеком. Выбор сохраняет
`runtime.json.previous`; прежний R надо сохранить для ручного возврата. Если были
source-профили, требуется явный выбор их каталога. Команда сама не переносит данные.
[Descriptor v3 и возврат](sea-desktop.md), [ручной запуск и служба](sea-launch.md).

Автоматического обновления бинарной поставки в первой версии нет. Status берётся из
manifest; source apply/update/web-rebuild возвращают `packaged_update_requires_package`.
Окно сообщает «Установите новый пакет GrigDesk». Замена версии — распаковка нового R,
проверка и явный выбор после остановки своего сервера. [Контракт обновления](sea-update-mode.md).
