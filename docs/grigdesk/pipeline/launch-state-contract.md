# Контракт запуска — по состоянию, не по stdout

`factory` при ошибке аргументов/профиля/маршрута и занятом task lock возвращает `rc≠0`.
`systemd-run` подтверждает только регистрацию transient service, поэтому старт GrigDesk
проверяет по полной pinned identity: `ATTEMPT_ID + ROUTE_HASH + ORCH_PID`, живому unit и
четырём последовательным чтениям. См. `POST /api/tasks/:id/launch`.

Источник до переноса: docs/grigdesk/gotchas.md § Контракт запуска — по состоянию, не по stdout
