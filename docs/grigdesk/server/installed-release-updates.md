# Обычная установка и подписанный выпуск

Официальный вход `tools/bundle.mts` использует `executeInstalledBundle`. Выход
`release-artifacts/` содержит `grigdesk-install`, его суммы/подпись, `desktop.tar.gz`,
`server.tar.gz`, `release-acceptance.json` и индекс выбранного канала. Исторический
локальный сборщик portable-комплекта сохранён без публикации; официальный выпуск
не создаёт переносимый комплект и не собирает исходники при установке.

## Номер и доверие

`VERSION` остаётся базовым X.Y.Z. CI до сборщиков проверяет ref: release требует
`vX.Y.Z` с совпадающим VERSION/commit; dev требует ветку dev и даёт X.Y.Z-dev.N.
Build identity один для server manifest, payload VERSION, help, web и desktop main.
Inputs workflow: channel, publish=false и необязательный notes — JSON с ru/en.
`GRIGDESK_RELEASE_NOTES_JSON` поступает в подписанный payload; пустое описание — null.

Индексы разделены: `/api/releases/v1/release.json` и `/api/releases/v1/dev.json` —
единственная версия API каналов (прежний переносной `channel.json` удалён до первого
выпуска). Payload содержит identity, notes, API, платформу и оба компонента.
Опись включает пути, размеры, SHA256 и права. Ed25519 подписывает domain separator,
LF, canonical JSON payload и завершающий LF. Общие reader/verifier — в shared/node;
пустой pinned key запрещает доверие.

Сеть ограничена HTTPS, запретом redirects, пятью секундами на источник и 1 MiB документа.
Cache/single-flight относятся к выбранному каналу. Проверенный локальный cache доступен
новому процессу CLI; ошибка сохраняется отдельно от последнего результата и времени.
Publisher проверяет подписи/архивы до SSH, извлекает help из проверенного ELF, сохраняет
immutable версии и переносит выбранный индекс последним. Другой канал не изменяется.

## Установка

`install local|remote|server` принимает `--root`, `--data-home`, `--user-data`,
`--bin-dir`, `--applications-dir`, `--unit-dir`. Значения — абсолютные пути.
Default root — пользовательская папка программы, данные и Electron userData — отдельно.
Серверному режиму не нужны GUI, репозиторий или системный Node/npm.
CI дополнительно собирает deb-бутстрап: пакет ставит `/usr/bin/grigdesk` и подписанный
installer, при первом запуске выполняется обычная установка local в `~/.local`;
обновлениями deb не управляет, пользовательская модель не меняется (`tools/buildDeb.mts`).

Приватный installation.json связывает uid, физический root, installationId, канал и режим.
Один current.json содержит ссылки на неизменяемые компоненты generations/version.
Launchers вызывают удержанный update/maintenance и читают current при каждом запуске.
Повтор installer над своей регистрацией готовит update через тот же manager; такой же
установленный manifest проверяется без повторной замены. Чужая регистрация/ярлык/unit — отказ.
При переходе с прежнего descriptor требуется закрыть старый сервер; descriptor сохраняется
в программе как резерв. Данные и старую portable-папку установщик не удаляет.

Local создаёт descriptor v5. Remote не создаёт descriptor, серверный компонент или unit.
Local/server получают user-unit с каноническим ExecStart, WorkingDirectory=I,
EnvironmentFile из D, KillMode=mixed и бюджетом слива 60 секунд. Регистрация не делает
самовольный enable/start; без user-systemd ctl использует manual launcher с PID/starttime lease.
I определяется из физического бинарника и проверенного receipt до загрузки server config;
ресурсы payload R и installationBin текущего поколения остаются отдельными путями.

## Подготовка и применение

InstalledUpdateManager хранит один installation-bound journal под PID/starttime lock.
Job фиксирует requestId, подписанный envelope/digest, scope, previous/target и исход.
Потоковое скачивание проверяет размер/SHA; ustar-распаковка принимает только подписанные
ordinary files. Links, лишние записи, traversal и превышение объёма запрещены.
Пробы работают в отдельной HOME/D, до ready current и процессы остаются прежними.

InstalledApplication подключает автономный сервис к main до соединения с машиной.
Optional appUpdates и снимок передаются существующим shell long-poll, без нового SSE.
Local готовит пару, remote — desktop; scope и выпуск закрепляются за job. При смене
local/remote режима apply требует вернуться к подходящему профилю, цель не подменяется.

Apply требует отдельного intent и свежего подтверждения количества ходов, очереди и задач.
Shared worker заново проверяет receipt, SHA/права, ресурсы, владельца, API и current-CAS.
После durable ACK он останавливает pipeline штатным Stop с бюджетом 20 секунд, затем
сливает сервер. Server shutdown записывает bound proof только после шагов и close Fastify;
forced exit, неизвестная активность и timeout не разрешают switch.

Main ждёт drain, сохраняет настройки/cookies и хвост stdout/stderr до своего exit.
Worker ждёт исчезновения старого процесса и одной записью заменяет current пары.
Worker и новые процессы запускаются в отдельных transient user-unit; без user manager —
в отдельных сессиях с собственными stdio. Завершение worker не завершает новое приложение.

Успех пары требует живого desktop ACK с nonce/build identity и серверного runtime-identity
с нужными version/packageId. Один новый диск или --version probe не означает completed.
Остановленный отдельный сервер остаётся остановленным: applied_not_started. Первый явный
start подтверждает runtime; обычный выход/запуск приложения не применяет отложенное ready.

## Владение и восстановление

Shared installedServer проверяет точный unit, ExecStart/WorkingDirectory/installationId,
uid/PID/starttime и boot instance. Manual требует lease канонического launcher.
Чужой owner не получает stop/start. Зарегистрированная служба active/inactive имеет
приоритет над child supervisor; второй сервер не создаётся.

При ожидании завершения `ENOENT` и `ESRCH` от чтения `/proc` означают, что процесс
уже завершился: он может исчезнуть между открытием `stat` и чтением его содержимого.
Worker продолжает подтверждённое обновление после выхода старого desktop.
`EPERM`, `EACCES` и другие ошибки доступа сохраняют отказ; PID с другим временем старта
или executable не считается прежним процессом и не получает сигнал.

Remote-сервер не получает update/stop/restart от updater окна. Offline desktop допускается
только при сохранении полного прежнего client API range; иначе ready требует связи с тем
же доверенным профилем. Настройки selected/pin/cookies остаются в прежнем userData.

Resume использует сохранённый envelope, а recovery сравнивает previous/target и возвращает
целое предыдущее поколение через того же владельца. Перед повторным запуском проверяется
подписанная опись retained generation. Ошибка rollback даёт manual_recovery_required.
Applied_not_started по умолчанию ждёт явного start; если новое поколение не запускается
на реальных данных, `resume-update --rollback` возвращает previous по явному согласию.
Успешное обновление удаляет свой staging (архивы, распаковки, пробы) и логи задания,
прореживая generations до current и previous; journal, данные и настройки сохраняются.
Старый portable recovery не подтверждает диск как runtime и не запускается
на registered-установке.

После подтверждённой смерти владельца installation lock общий механизм убирает его
и повторяет захват в том же вызове, включая `waitMs: 0`. Это действует при confirm,
apply и recover; живой или неизвестный владелец остаётся препятствием. Ручное удаление
блокировки для первого resume не требуется. [Контракт блокировки](../overview/directory-lock-recovery.md).

`GET /api/system/runtime-identity` закрыт общим auth guard. Update-drain требует CLI-токен
и bound intent/job/digest. Legacy package-update запрещён на registered-паре и направляет
server-only в CLI, чтобы старый клиент не обновил половину комплекта.

## Граница приёмки

Исходный и Android-клиенты сохраняют API 0.1; Android updater сюда не входит.
Ключ доверия и доступы CI/сайта задаёт владелец. Реальные Actions ELF/AppImage, публикация,
процессные fault-матрицы и браузерная приёмка обязательны перед пользовательским выпуском;
синтетические компоненты и зелёные прежние тесты их не заменяют.
