# Авторизация и CLI-токен

Весь `/api` за сессией (httpOnly cookie). Для локальных CLI (`b24`, ship-этап фабрики,
скиллы) — `<папка данных>/state/cli-token` (0600, создаётся сервером): заголовок `X-GrigDesk-Token`.
`b24` сам выбирает папку данных и читает токен; `GRIGDESK_TOKEN` и `GRIGDESK_CLI_TOKEN_PATH`
переопределяют его, старую раскладку он не читает ([команда b24](../b24/binary-cli.md)).
У CLI `grigdesk-ctl` до переноса действует
[переходное чтение старой раскладки](data-home.md#команды-и-тесты).
Внутренний `internalToken` (in-memory, per-process) — для permission-mcp чата.

[Ключ локального окна](window-key.md) обменивается на обычную сессию отдельной ручкой.
CLI/internal-токены не заменяют этот ключ. Парольный механизм снят; общий гард также
закрывает HTML и ассеты. [Контракт доступа](desktop-only-access.md).

Источник до переноса: docs/grigdesk/architecture.md § Авторизация и CLI-токен
