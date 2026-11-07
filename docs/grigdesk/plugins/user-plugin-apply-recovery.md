# Durable замена плагина и восстановление процесса

Транзакция работает с каталогами plugins/id, jobs/jobId/package, transactions/transactionId,
previous/id и replaced/archiveKey. Пути вычисляются из config и проверенных id/UUID;
persisted JSON содержит identities dev/ino и managed payloadDigest. Корни, каждый
существующий компонент пути и тип каталога проверяются без следования по ссылкам.
Разные filesystem devices отвергаются до rename; copying fallback отсутствует.

Prepared intent публикуется вместе с переводом ready job в applying, до первого rename.
Current становится parked, candidate — current. Каждый rename синхронизирует оба
parent каталога. Managed current становится previous после переноса прежней previous
в retired; ручная или показанная изменённая копия целиком сохраняется в replaced.
ArchiveKey фиксируется в intent, recovery не строит его по новой дате.

Одна durable запись публикует target record, job.done, completed summary, исходный
rollback receipt, backupRef и разрешённые cleanup entries, очищая apply intent.
Retired удаляется только после этой записи и только при совпадении ожидаемой identity
и digest. Чужой retired или содержимое transaction остаётся на диске. Ошибка cleanup
сохраняет entry для повтора; установленная версия не получает failed.

Resolver сопоставляет реальные copies по identity/digest, даже при crash между rename
и записью фазы. Он либо заканчивает archive/commit, либо подтверждает восстановленный
current и failed, либо сохраняет copies/intent и recovery_required. Повтор blocked
recovery не изменяет revision снова. Ошибка writer после rename state требует перечитать
диск: уже опубликованный record/done/receipt не отменяются исключением fsync.

Проверено 93 настоящими SIGKILL barriers после filesystem effects, до и после durable
writes для install/update/replacement/rollback. Отдельные process проверки сохраняют
commit до ACK, rollback receipt до commit и тот же archiveKey при другом clock нового
resolver. Матрица одиночных отказов покрывает rename, syncDir, ensureDir, writes и cleanup.
Это гарантия восстановления процесса; аварийное отключение питания не тестировалось.

Непустой worker registry запрещает filesystem resolver до проверки и drain в installer
service. Битый/unreadable state и orphan work не дают права удалить copies или сигналить
по PID. Сам apply/recovery helper не импортирует server.js; положительный fixture control
доказывает работающий import marker. Startup и module lifecycle проверяются отдельно,
а production вызов транзакции требует owner/admission/runtime lease.
