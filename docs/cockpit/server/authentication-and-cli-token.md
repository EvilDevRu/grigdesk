# Авторизация и CLI-токен

Весь `/api` за сессией (httpOnly cookie). Для локальных CLI (bin/b24, ship-этап фабрики,
скиллы) — `server/.state/cli-token` (0600, создаётся сервером): заголовок `X-Cockpit-Token`.
`bin/b24` сам читает токен от РЕАЛЬНОГО пути скрипта (readlink -f, симлинк из ~/.local/bin).
Внутренний `internalToken` (in-memory, per-process) — для permission-mcp чата.

Источник до переноса: docs/cockpit/architecture.md § Авторизация и CLI-токен
