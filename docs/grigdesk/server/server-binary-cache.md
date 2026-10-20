# Кэш серверного payload

Обозначения I/D/R, команды prepare/verify/prune и граница владения launcher/окна собраны
в [обзоре одиночного ELF](server-binary.md). Установка и сохранение backup —
[отдельный контракт](server-binary-install.md); ручная уборка ниже не заменяет откат.

Общий `shared/node/payloadCache.ts` публикует приватный staging под package lock:
сначала файлы, затем внутренние ссылки, полный SHA/size/mode/composition verify и marker,
после этого atomic rename. Поколения имеют root 0700, файлы 0444/0555 и marker 0600.
Данные сервера выбирают `D/runtimes/server`, API cache override отсутствует.

Marker format 2 связывает packageId, payloadSha256 и bigint lstat fingerprints:
ino, size, mode, mtimeNs, ctimeNs. Warm проверяет полный состав и fingerprints без
открытия ZIP и без hashes файлов. Изменение ctime либо явный fullVerify вызывает полный
пересчёт; snapshot повторно проверяется после чтения bytes.

Сервер восстанавливает отсутствующий, неразбираемый или несовместимый marker после полного
verify. Чужая identity, marker-link, повреждённые bytes и лишние файлы дают именованный отказ;
готовое поколение не удаляется. DeepSeek adapter сохраняет строгий отказ для повреждённого marker.
Обновление marker идёт через существующий inode с O_NOFOLLOW под package lock.

`afterReady` вызывается под тем же lock до возврата как нового, так и прогретого поколения.
Он позволяет опубликовать владение процессом без окна между готовностью и освобождением lock.

## Владение процессами и попытками

`binary/leases.ts` создаёт lease формата 1 в `leases/<packageId>/<UUID>.json` (0600).
`materializeWithLease` публикует её в `afterReady`, удерживая lock распаковщика. Prepare
принадлежит PID/starttime родителя probe. Launcher под тем же package lock добавляет себя,
отправляет exact IPC ACK и после spawn добавляет worker. Координатор снимает только свою
identity; cleanup launcher не снимает worker. Проверка `/proc/<pid>/stat` отличает PID reuse,
zombie и отсутствующий PID от временной ошибки доступа. Неизвестное состояние сохраняет R.

Попытка получает durable reservation до запуска engine: host сначала сохраняет registry
`state/control-roots.json`, затем `CONTROL/server-runtimes/reservations/<UUID>.json` и индекс.
Смерть PID и возраст не снимают reservation. Движок сам генерирует attempt ID; после
публикации immutable attempt directory, до active pointer он вызывает `factory-runtime-pin`.
Helper проверяет checksum и exact identity read-only, публикует authority pin через CAS,
затем производный индекс `attempt-pins/<scope>/<attempt>.json`, после этого снимает reservation.
Ошибка bind оставляет orphan directory и reservation и не допускает первый provider.

Authority находится в `CONTROL/server-runtimes/<scope>/<attempt>.json`, вне provider state.
Scope — SHA256 canonical JSON именованных физических control/state/profile roots. Pin не
меняет attempt, catalog, route, cursor или result. GC перечитывает все зарегистрированные
roots; потеря derived index не означает отсутствие pin. Ошибка чтения прежнего root и
потеря registry означают keep. Только проверенный immutable terminal (`finished`/`abandoned`)
освобождает reference. Legacy/source pins имеют nullable packageId и не удаляются GC.

`--release-preparation` подтверждает полную kernel identity координатора. Повтор после ACK
сохраняет server owners и успешен по квитанции `state/released-leases/<id>/<token>.json`.
Случайный чужой token без квитанции получает отказ. Квитанции не удерживают поколения.
Host helper в режиме `run` записывает lease scope leader и engine child; переживший сервер
движок сохраняет собственное владение. Эти metadata не передаются через публичный API.

## Продолжение после смены сервера

Перед каждой командой существующей попытки `prepareFactoryRouteLaunch` выбирает authority pin.
Engine, его `FACTORY_HOME`, helper Node и resources берутся из одного закреплённого runtime.
Пути внешних CLI, profiles, control и provider state остаются общими. Настройки окружения и
`extraEnv` не подменяют закреплённый runtime. Синхронный gate и отвязанный resume используют
одну границу выбора; новая попытка резервирует текущую поставку.

Первое безопасное продолжение legacy/source проверяет trusted protocol v2 и checksum identity,
затем создаёт sidecar через host CAS. Для внешнего legacy R/source packageId=null. Оно не переписывает старые attempt/catalog/route bytes.
Отсутствующий ожидаемый pin и несовместимый protocol дают typed-отказ до мутации ворот.
Возврат поддерживает обновлённый source с этим reader-контрактом.

## Ручная уборка

`pruneServerCache` вызывается только явной командой `--cache-prune --json`.
`recordServerRuntimeUsage` записывает lastUsed в `state/usage.json`; run обновляет current/previous,
prepare только отмечает использование. Usage вызывается после materialize и вне package lock.
Инициализированные registry и usage имеют отдельные маркеры: утрата истории не означает пустой кэш.

GC удерживает global lock, затем package lock и повторно проверяет usage, leases, reservation
и authority всех зарегистрированных roots. Current/previous сохраняются всегда. Более старое
поколение удаляется только после семи полных суток без использования и без защиты.
Неизвестные owner, root, index, protocol, terminal или symlink дают `unknown` и сохраняются.
Hash terminal не заменяет проверку его закрытой схемы и exact task/attempt identity.

Удаление начинается с rename в собственный private `.trash` под package lock. После rename
новый launcher создаёт R заново либо уже удерживает lease; второй GC перечитывает защиту.
При ошибке удаления целый trash возвращается на место. Частичный trash остаётся приватным
для разбора и никогда не объявляется готовым поколением. Backup ELF, profiles и chats уборка
не затрагивает. Ответ содержит deleted, retained с причиной и unknown; автоматического GC нет.
