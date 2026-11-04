# Browser run stale из-за прав каталога capability

Живое окно не доказывает готовность транспорта этапа. Если `relay.log` содержит только
`browser_run_stale`, а `host.ready` отсутствует, сначала проверяйте publisher и локальную
authority. Отказ происходит раньше mailbox, socket, broker и обращения к окну.

Проверенный случай: `run_state_begin` создавал `control/runs` и каталог задачи через
обычный `mkdir -p`. При umask `0002` получались права `0775`. Новый browser reader проверяет
всех родителей protected записи и отвергает group-writable каталоги, даже если сама
capability имеет `0600`, курсор свежий и identity процесса правильная. До `matches()`
такой запуск не доходит. Старый упакованный helper на копии состояния воспроизводит
отказ при `0775` и успешно публикует binding после изменения только этих прав на `0700`.
Небезопасный родитель останавливает publisher даже до первого чтения trusted cursor:
это отдельно проверяется для `runs` и каталога задачи, без изменения самого reader.

Исправление принадлежит writer движка: до записи capability он проверяет owned canonical
каталоги без symlink и устанавливает `0700` для `runs` и каталога задачи. Это применяется
и к прежним каталогам при следующем запуске. Ослаблять browser authority или ждать
обновления курсора при таком отказе нельзя: задержка права не меняет.

Launcher больше не пропускает отказ подготовки, publisher или readiness. Он останавливает
ещё удержанный процесс, снимает собственную identity и binding, возвращает host failure.
Маршрут не коммитит `skipped`/`exhausted`, не расходует no-result retries и сохраняет узел
для resume. Причина из helper попадает в комментарий и stages log; карточка называет
браузерный транспорт и исходный код вместо общей недоступности окна.

Readiness подтверждает также heartbeat relay через зашифрованный lease на две секунды:
PID хоста не обязан быть виден в namespace агента. Обновление каждые 500 мс продолжается
и во время долгой команды. Отсутствие readiness или истечение lease до request —
`browser_transport_dead`; потеря ответа уже отправленного эффекта — `outcome_unknown`.
Логи не читаются агентом как текст ошибки: launcher передаёт только машинный код,
а содержимое запроса, пути и capability не отражаются в ответе CLI/MCP.

Регрессии: `factory-browser-identity.test.mts` использует настоящий writer под umask `0002`;
`factory-browser-entry.test.mts` проверяет CLI без mailbox, без readiness и после смерти relay;
`factory-browser-relay.test.mts` — настоящий relay, обновление lease во время долгого
socket request и истечение readiness после SIGKILL;
`contract/browser-transport.sh` — publisher failure/retry и readiness barrier, включая
отказ чтения mode, три попытки stale и единственную попытку другого отказа publisher;
`integration/route-multi-runner.sh` и `integration/route-dispatch.sh` — отказ без запуска
модели, расхода retries и изменения курсора. `factory-browser-stall.test.mts` проверяет
сохранение причины в карточке поверх итоговой строки диспетчера.
