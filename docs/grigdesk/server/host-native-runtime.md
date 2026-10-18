# Сервер — host-native, не контейнеризуется

Командует host-уровнем: `factory bin`, `/proc`, `~/.factory/state`, `docker`. В контейнере
`factory` побежал бы внутри контейнера — модель «мозга» ломается. Поэтому systemd, не Docker.
Фронт отдаёт сам сервер; интерфейс обращается только к своему origin.

Источник до переноса: docs/grigdesk/gotchas.md § Сервер — host-native, не контейнеризуется
