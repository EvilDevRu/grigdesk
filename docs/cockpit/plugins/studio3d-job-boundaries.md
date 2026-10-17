# Границы выполнения заказов 3D

`server/src/lib/studio3d/jobs.ts` владеет журналом, выбором аккаунта, admission и очередью
отправки. Публичный баланс собирает локальные и durable резервы только своего аккаунта.
Dispatch исключает текущего child и проверяет пул до решения о допуске платного POST.

`jobReservations.ts` содержит чистый `unreflectedReservationAmount`. Он складывает ещё не
принятые резервы и принятую сумму, из которой вычтено уже отражённое падение available.
Unknown available не подтверждает списание: весь известный резерв сохраняется. Значения
с `balanceBefore: null` учитываются отдельно, а падение баланса не уменьшает их сумму.

Один расчёт используется в balanceView и dispatch. Он не выбирает аккаунт, не читает
журнал и не меняет входы; provider reserved не вычитается повторно. Проверки неизвестного
или некорректного баланса остаются у потребителя.

`jobDownloadQueue.ts` владеет ожидающими и активными скачиваниями. Enqueue только
дедуплицирует ключ `intentId:childId`; запуск начинается через pump. Одновременно активны
не более двух работ. Promise с finally освобождает слот и запускает следующего; отдельный
catch предотвращает unhandled rejection, сохраняя отказ для settle.

Jobs создаёт очередь в конструкторе после options/admission и передаёт run и isStopped.
Он сохраняет остановку, AbortController, cancelReads, таймер, admission и leases. Busy
читает только activeCount; новый отдельный признак waiting не добавляется.

Settle сохраняет цикл pump/Promise.all и распространяет отказ активной работы.
Остановка синхронно вызывает clearWaiting, ждёт tick, затем waitActive через allSettled
и освобождает leases. Settle применяется к работающей очереди; lifecycle остановки
использует отдельные clearWaiting/waitActive. Poll не ждёт скачивания другой модели.

`jobErrors.ts` определяет общие JobError, InjectedCrash и безопасную форму fallbackError.
Jobs реэкспортирует прежний JobError. Fault hook и скачивание используют один класс
InjectedCrash: авария после скачивания выходит наружу, включая необязательный output.

`jobDownloads.ts` владеет publishFile, обновлением CDN URL и скачиванием результата.
Он получает library/intents, signal, часы и callbacks Jobs. Provider port содержит
snapshot/isCurrent/poll и не предоставляет send. Jobs создаёт компонент в конструкторе;
локальный результат и CDN используют одну публикацию по подтверждённому SHA.

Required roles и main file проверяются до скачивания. Подтверждение fd, SHA, размера и
контейнера предшествует manifest и ready. Pinned directory закрывается в finally.
После change завершённый record передаётся refreshLease как при success, так и при
failure. Остановка сохраняет прежний durable исход; ошибка CDN сохраняет charged и
возможность бесплатного redownload. Внутренний catch допускает обычный отказ optional
output, а InjectedCrash распространяется к ожидающему settle.

`jobRequest.ts` содержит validateRunRequest, requirePrice и закрытый набор runKeys.
Jobs реэкспортирует прежний валидатор; TASK_ID_RE принадлежит dispatch/reconcile и остаётся
в Jobs. Проверки не зависят от текущего каталога при replay.

`jobBatches.ts` владеет расчётом пачки, детерминированным UUID строки, materializeBatch,
batchBlocked, сводкой batch и асинхронным телом acceptBatch. Ему передаются общие
library/intents/admission и callbacks buildIntent, materialize одного run, change,
injectFault и wake. Jobs сохраняет materialize/project одного run и lifecycle.

Карты inflight/inflightBatches и оболочка runBatch остаются в Jobs. Validation/capture,
исходный fingerprint, перекрёстная проверка UUID run↔batch, coalescing и admission lease
предшествуют делегированию тела; finally завершает прежний lease и снимает регистрацию.
Новая UUID-регистрация и отдельная блокировка не создаются.

Parent сохраняет все шаблоны до проекций строк. Чтение paused sibling и изменение waitReason
сохраняют прежние await, включая вызов из admission-lock dispatch. Сам dispatch и его
последний синхронный допуск перед платным POST принадлежат Jobs. Новая цена строки
приостанавливает неотправленных соседей; принятая строка продолжает poll и скачивание.
