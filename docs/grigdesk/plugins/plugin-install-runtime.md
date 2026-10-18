# Runtime lease и HTTP установки

Модуль плагинов принимает installer port. До scan он выполняет recovery; blocked ids
не импортируются. Повреждённое общее состояние блокирует все user plugins, сохраняя
системный каталог и API ядра. Ошибка describe не роняет весь каталог.

## Закрытие runtime

Каждый зарегистрированный user scope получает admission gate до static и server
routes. Он учитывает HTTP response до finish/close/error и WebSocket до закрытия
socket, освобождая допуск один раз. Замена синхронно запрещает новые запросы и ждёт
уже принятые. Drain ограничен пятью секундами и не обрывает работающие streams/WS.

Диагностический busyReason возвращает trim строку причины, null/false/пустую строку
для свободного состояния. Ошибка, неизвестное значение или timeout дают безопасную
неизвестную занятость. Диагностика сама не предоставляет право замены.

Loaded server без prepareReplace требует выключения и ручного перезапуска. Hook
должен остановить свой фон и возвратить удерживаемый lease. Installed и blocked
оставляют gate закрытым до рестарта; reverted открывает его после успешного finish.
Timeout посылает abort, но ждёт подтверждения cleanup: второй hook не запускается,
поздний lease получает reverted. Неудачный finish оставляет gate закрытым.

Попытка server import отмечается potentially loaded до выполнения. Failed import
или register могут оставить top-level timer/child; такой runtime требует остановки,
даже если успел назначить hook. Ошибка одного user module не рушит ядро.

После commit старые routes отвечают plugin_restart_required; во время замены —
plugin_replacing; при blocked — recovery_required. Новые файлы не раздаются прежнему
runtime. Участие внешнего CLI и остановка его процессов — контракт самого плагина.

## Данные и каталог

Server options получают прежние config/prefs/plugin/prefix и общую mutable lifecycle
ссылку. DataDir создаётся с 0700 вне дерева установки. Пересекающиеся roots, ссылки и
предок-файл отвергаются до import. Legacy регистрация без installer сохраняет
совместимость со старой конфигурацией.

Refresh сначала готовит полный scan и byId, затем одновременно публикует каталог.
Новый server при этом не импортируется; новый id без явного prefs остаётся выключен.
Успешная регистрация static считается loaded. Dormant plugin не требует server lease.

## Авторизация и сериализация

Installer endpoints используют настоящий общий auth guard. GET current/jobById
доступны session/CLI/internal. POST versions/jobs/apply/cancel/update/rollback/check
требуют session, JSON и допустимый Origin, если он передан. Локальный AJV отвергает
лишние поля и coercion; production defaults остальных scopes сохраняются.

Ответы содержат публичный job/source/install DTO; internal workers, staging paths и
prepared snapshots удаляются схемой сериализации. BackupRef проверяется отдельно как
basename архива: serializer string pattern сам значения не валидирует. Известная
PluginInstallError сохраняет HTTP/code/безопасный текст. Неизвестный exception не
попадает ни в body, ни в log.

Потерянный HTTP ответ после durable commit не меняет done. GetJob по исходному id и
receipt прежнего rollback request возвращают тот же outcome при активном другом
job. После retention API честно даёт job_not_found.

Это подключение модуля проверено отдельными Fastify fixtures с настоящими Git,
HTTP sockets, streams и WebSocket. Boot проверен [отдельно](plugin-install-boot.md).
Веб-интерфейс подключён к каталогу; его восстановление задания и неизвестного
исхода описано в [контракте интерфейса](../web/plugin-install-ui.md).

Отказ scanner refresh не отменяет commit. Следующий GET каталога повторяет refresh
при отдельной health ошибке; неудачная попытка сохраняет прежний список и SYSTEM.
Допущенный refresh принадлежит read admission: close ждёт его перед отпусканием owner.
Проверено R10-refresh и M45-refresh через реальные filesystem и отдельный barrier.
