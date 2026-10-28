# Срок прямого вопроса исполнителя

В `modules/chat/index.ts` прямые callbacks исполнителя проходят через
`requestDirectInteraction`. Он пишет запись в общую `pendingPerms` напрямую,
без вызова `permissionQueue.enqueue`. Поэтому суточный таймер enqueue на этом
пути не устанавливается; наличие общей очереди ещё не означает общий deadline.

Прямой запрос снимают ответ HTTP, отмена `presentation.signal` и `dropPending`
при завершении/остановке чата. Для вопроса `finally(releaseQuestion)` освобождает
удержание канала уточнений. Если адаптеру нужен deadline, он должен обеспечить
отмену своего ожидания; короткий timeout пользовательского ответа продуктом
не предусмотрен.

Суточный `PERM_WAIT_MS` в chat route применяется к HTTP permission-пути, а
`DEFAULT_TIMEOUT_MS` в `chat/permissionQueue.ts` — к вызовам enqueue. Эти механизмы
нельзя считать доказательством срока direct callback. Факт проверен по исходникам;
поведение отдельных адаптеров зависит также от их signal и native lifecycle.

У Codex собственный scoped waiter использует общую суточную константу
`PERMISSION_WAIT_MS`. Deadline отменяет presentation.signal и возвращает отказ;
native resolved, stop и завершение своего хода снимают ожидание раньше. Это не
меняет lifetime остальных direct providers. Контракт — [режимы Codex](codex-permission-modes.md).
