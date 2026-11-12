# Контракт запуска — по состоянию, не по stdout

`factory` при ошибке аргументов/профиля/маршрута и занятом task lock возвращает `rc≠0`.
`systemd-run` подтверждает только регистрацию transient service, поэтому старт GrigDesk
проверяет по полной pinned identity: `ATTEMPT_ID + ROUTE_HASH + ORCH_PID`, живому unit и
четырём последовательным чтениям. См. `POST /api/tasks/:id/launch`.

Отказ подготовки CLI до spawn допускает повтор после rollback и доказанного отсутствия
реестра, control-каталога задачи и резервации слота. Один `invalid` или пустое состояние
после передачи движку не снимают pending. Подробности —
[отказ подготовки CLI](cli-preparation-retry.md).
