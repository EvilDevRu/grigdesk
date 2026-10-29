# Codex: код процесса и отсутствие результата этапа

`run_agent` возвращает transport-успех при rc=0, даже если runner не вызвал
stage-result. В этом случае реестр остаётся running, а active record не содержит
terminal результата. `_route_v2_active_result` отвергает такой record кодом 78;
`_route_v2_run_agent_node` распознаёт STATE=active и возвращает noResult/75, чтобы
применить уже заданный бюджет узла. rc=0 сам по себе не создаёт done.

Это отличается от предположения, что run_agent всегда возвращает missing_status.
`missing_status` существует как имя класса/подпись, но обычное отсутствие terminal
CAS проверяет runtime маршрута. Регрессии: route-multi-runner и route-retry-wrapup.
Native denied одной команды не подменяет этот контракт: разрешённая альтернатива
может записать done, невозможность сдачи — failed с failure-owner human.
