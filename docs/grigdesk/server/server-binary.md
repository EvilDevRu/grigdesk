# Сервер одним ELF

Linux x64 сервер поставляется одним `grigdesk-server`: внешний ELF содержит launcher,
защищённый индекс и ZIP ресурсов. При запуске он подготавливает поколение в папке данных
и запускает обычный Node из этого поколения. Для работы сервера системный Node и checkout
не нужны. Административный установщик, окно и внешние CLI устанавливаются отдельно.

[Прежний каталог SEA](node-sea.md) и запуск из исходников сохраняют свои контракты.
Новая раскладка и порядок PATH применяются только к режиму payload.

## Раскладка I, D и R

| Обозначение | Содержимое и граница |
| --- | --- |
| `I` | Физический корень установки: `I/bin/grigdesk-server`, отдельные CLI и окно. |
| `D` | [Папка данных](data-home.md): `.env`, история, профили, runtime cache и служебные хранилища. |
| `R` | `D/runtimes/server/packages/<packageId>`: проверенное поколение ресурсов сервера. |

ELF находится в I, а ресурсный R выводится из физического `server/payload.cjs`.
Рабочая папка процесса не определяет ни один из этих корней. D не может находиться внутри I
или содержать установку; размещение R внутри D является штатным случаем. Подробнее:
[пути ресурсов](server-binary-paths.md), [ранний guard](server-binary-placement.md).

В R находятся `runtime/node`, `server/payload.cjs`, `server/worker-bootstrap.cjs`,
production npm, `server/runtime/helpers`, `engine/bin`, `engine/lib`, `schemas/analytics`,
лицензии и ресурсы по `server/build/binary-resources.json`. Собственные TypeScript-исходники,
UI/web-dist, ключи, наружные ссылки и самостоятельные ELF DeepSeek/Б24/посредника не включаются.
Исходники сторонних npm-пакетов разрешены. Файлы имеют режимы 0444/0555, каталоги — 0700;
история и изменяемое состояние не записываются в R.

`packageId` — SHA256 канонического полного manifest с launcher, payload и входами сборки.
SHA256 конечного ELF вычисляется отдельно после внедрения assets. Публичная metadata не
раскрывает приватный файловый индекс. Версия пакета — 0.1.0, packagingVersion — 2,
runtime — Node 24.21.0 / ABI 137. [Полный контракт identity](server-binary-contract.md).

## Команды ELF

Таблица относится к одиночному ELF. JSON режимы и aliases прежнего R имеют собственный
[контракт SEA](sea-runtime-checks.md).

| Аргументы | Результат и работа с данными |
| --- | --- |
| Без аргументов | Подготовка R и запуск API обычным Node. |
| `--help` | Справка из assets, без D и запуска API. |
| `--version` или `--version --json` | Версия либо публичная metadata из assets, без D. |
| `--runtime-info --json` | Публичная metadata; D, `.env` и ZIP не читаются. |
| `--license` | Лицензия Node из assets, без D. |
| `--prepare --json` | Подготовка R и preparation handle без запуска API. |
| `--verify` или `--verify --json` | Полная проверка R, Node/ABI, двух native bindings и SHA ELF. |
| `--check-startup` | Совместимый alias prepare с JSON и `ok: true`; может создать D/cache. |
| `--check-runtime` | Совместимый alias полной verify с JSON. |
| `--cache-prune --json` | Явная ручная уборка cache с причинами retained/unknown. |
| `--release-preparation TOKEN --package-id ID --json` | Снятие владельца координатора, ответ `ok: true`. |

`--expect-package-id ID` допустим у run, prepare и verify. Несовпадение даёт
`server_package_changed` до подготовки другого поколения. Run с
`--expect-package-id ID --preparation-token TOKEN` принимает подготовленный handle.
Release требует ID прежнего handle и не привязывает его к версии заменившего ELF.

Повторяющиеся, неизвестные и несовместимые флаги дают код 2 до обращения к D. Общего режима
интерпретатора нет: `--eval`, `--require` и произвольный Node argv не поддерживаются.
Ошибки размещения/настроек D дают 78, прочие отказы служебных команд — 1; работающий сервер
сохраняет код обычного worker, включая запрос перезапуска 75.

## Launcher, IPC и кэш

Launcher сверяет канонический manifest с отдельным package-id asset до обращения к D.
На cold распаковщик проверяет полный состав, размеры, SHA и режимы перед атомарной
публикацией R. На warm проверяются состав и kernel fingerprints без открытия ZIP и полного
хеширования payload/ELF. Явная verify всегда пересчитывает содержимое. Правила marker,
повреждений, locks, leases, pins и ручного GC — в [контракте кэша](server-binary-cache.md).

Prepare возвращает ровно `packageId`, `root`, `node`, `engine`, `installationBin` и
`preparationToken`. Lease создаётся под package lock до возврата handle. Во время запуска
launcher принимает handle, записывает собственного владельца и отправляет точный IPC ACK.
Worker разрешено загрузить после записи его владельца. Координатор освобождает только свою
PID/starttime identity; [окно](server-binary-desktop.md) держит её во время VPN/cwd/spawn.

`packagedLaunchEnvironment` читает раннюю `.env` с приоритетом исходного env. Оно передаёт
`NODE_EXTRA_CA_CERTS` до старта Node worker и очищает loader inputs, включая `NODE_OPTIONS`.
Внутренний IPC существует и при ручном старте: смерть launcher останавливает worker.
Внешний IPC означает владение окном. TERM/INT пересылаются один раз, shutdown получает
бюджет не менее 45 секунд; эскалация завершает только собственного worker с ошибкой.
Отвязанная фабрика сохраняет отдельное владение своим поколением.

GC запускается только `--cache-prune --json`. Он сохраняет current/previous, живые leases,
durable reservations, pins незавершённых попыток и неизвестные состояния. Неиспользуемые
старые поколения удаляются после семи полных суток. Резервные ELF, profiles и chats GC
не удаляет; сроки и порядок locks определены [отдельно](server-binary-cache.md#ручная-уборка).

## Окно, PATH и движок

Descriptor v4 хранит физический binary, D и каталоги CLI, а текущие packageId/R получает
при подготовке каждого запуска. Выбор установленного ELF не равен установке или рестарту.
Descriptor v1/v2 для source и v3 для прежнего R сохраняются. Транзакция выбора, recovery,
передача preparation и возврат описаны в [контракте окна](server-binary-desktop.md).

Порядок PATH общий для launcher, окна, PTY и фабрики: I/bin, явные и сохранённые каталоги,
пользовательские CLI и унаследованный PATH, найденные nvm, последним собственный Node.
Shell rc не исполняются, symlink workaround для nvm не нужен. Helpers/MCP запускаются
явным Node из R. Точные правила discovery — [PATH одиночного ELF](server-binary-path.md).

По умолчанию фабрика использует движок поставки и физические профили в D. Explicit external
engine — отдельный режим. Существующая попытка продолжает закреплённые engine/Node/resources
после замены сервера, новая выбирает текущую поставку. См. [движок и профили](server-binary-factory.md),
[pins и продолжение](server-binary-cache.md#продолжение-после-смены-сервера),
[Factory helpers](server-binary-factory-helpers.md) и [hooks](server-binary-hooks.md).

## Сборка и приёмка

Payload готовится существующими стадиями Node, npm, ресурсов и helpers. Собственный серверный
граф собирается в CJS для обычного Node, без вложенного серверного SEA. Launcher встраивает
ZIP adapter и `fflate`; библиотека остаётся exact devDependency сборщика.
Подготовленные production npm копируются строго по lock. Два native binding пересобираются
офлайн собственным Node и заголовками поставки и проверяются отдельными процессами.

Сборщику заранее передают архив pinned Node с SHA из `server/build/node-runtime.json`
в cache и отдельную копию старого R в `cache/baseline-release`. Runtime/dependencies не
скачиваются при запуске готового сервера. Пример отдельных каталогов сборки:

```sh
npm --prefix server run build:binary -- \
  --out-dir /artifacts/server/release \
  --cache-dir /artifacts/server/build-cache
```

Сборщик выпускает `grigdesk-server` и `build-result.json` без установки. Стадии работают
на переднем плане с timeout и отдельными log/exit. Ошибка подготовки, bundle, package,
blob, postject или smoke сохраняет прежний опубликованный ELF.

Перед сборкой проверяют свободный диск с учётом staging, ZIP, cache, двух поколений и backup.
Ранние ворота E0 включают metadata, prepare, verify, authenticated HTTP/IPC, пустой PATH,
размер ELF ≤450 MiB, суммарный RSS сборки ≤4096 MiB, cold ≤30 с и warm ratio ≤2.0.
Полная приёмка отдельно проверяет следующие свойства:

- Настоящие chat turns и resume через compiled adapters в `R/server/payload.cjs`, отдельно
  production API/window-key/IPC. Namespace не монтирует checkout/HOME, host Node заменён exit97.
- Factory wrappers, hook policy, статусный ledger и продолжение закреплённой попытки после
  замены сервера. Chat-приёмка не подтверждает Factory/ACP; [initialize имеет свой контракт](../pipeline/deepseek-acp-startup.md).
- Raw→authenticated API и desktop preflight→API с prepare/VPN: 5 разогревов, 15 чередующихся
  пар R/ELF и 3 cold cache на каждый сценарий. Host page cache не сбрасывается.
- Warm median/p95 ≤2× baseline, cold ≤30 с, суммарный RSS ≤4096 MiB, generation ≤1.25×
  старого R по allocated и logical bytes, warm payload hashes=0; место измеряется до/после GC.

Процессные проверки идут через `tests/run-node-tests-safe.sh` с concurrency1. Модельная сеть
тестов — loopback, ключи синтетические. Отчёты содержат SHA кандидата и исходные samples.
Изменение payload требует новой сборки и повторов на её SHA; старые отчёты не подтверждают
новый ELF. Обычные release-проверки и [явный legacy SEA gate](sea-release-gate.md) разделены.

## Установка, откат и действия владельца

В payload статус читает защищённый VERSION и runtime metadata. Source apply/update/web rebuild
отказывают HTTP 409 до создания job с сообщением «Установите новый пакет GrigDesk».
Автоматического обновления ELF нет. Полный порядок staged verify, private receipt,
backup и повторной установки резервного ELF — в [инструкции установщика](server-binary-install.md).

Владелец выполняет действия последовательно:

1. Устанавливает проверенный candidate отдельным Node машины установки или прежнего R.
   Установщик не останавливает работающий сервер и не переключает окно.
2. Закрывает окно и останавливает владельца D; затем явно выбирает установленный ELF
   через `grigdesk-ctl desktop use-server`. Две копии сервера на одном D не запускаются.
3. При необходимости регистрирует службу штатным deploy-скриптом. `--unit-only` записывает
   unit и делает daemon-reload; standalone ExecStart указывает на I/bin/ELF, cwd — I.
4. Запускает сервер, проверяет окно и настоящую user-службу. Для отката повторно устанавливает
   backup либо явно возвращает окно к сохранённому legacy R/обновлённым исходникам.

Установку в настоящий bin, выбор окна, службу, перезапуск и GUI-проверку выполняет человек.
Проверки supervisor/systemctl на заглушках не подтверждают графический сеанс или службу.
Перезапуск из чата убивает собственный ход агента и этим порядком не выполняется.

ELF рассчитан на Linux x64 с совместимыми glibc и системными библиотеками; это не статический
бинарник для любой libc. Bash, системные утилиты, Python PTY, ffmpeg, браузеры, модели речи,
внешние CLI и их авторизация остаются зависимостями соответствующих возможностей.
DeepSeek/GLM используют отдельный DeepSeek ELF от I/bin либо явного override. Б24, посредник
и окно не дублируются в payload. Boot не устанавливает пакеты или дополнительные runtime.
