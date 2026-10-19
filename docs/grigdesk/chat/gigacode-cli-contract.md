# GigaCode CLI: документированные возможности и граница проверки

Сведения проверены по официальной документации GitVerse 18 октября 2026 года.
Они относятся к GigaCode Сбера / GitVerse. У других продуктов с именем Gigacode
другие контракты; совпадение имени исполняемого файла не подтверждает совместимость.

## Что описывает поставщик

[GigaCode CLI](https://gitverse.ru/docs/ai/ai-assistant-gigacode/gigacode-cli/)
представлен как терминальный агент разработки.

[Документация MCP](https://gitverse.ru/docs/ai/ai-assistant-gigacode/gigacode-cli/mcp)
описывает `mcpServers` в `settings.json`, пользовательский и проектный уровни,
транспорты stdio/HTTP/SSE и ожидание discovery до первого prompt в неинтерактивном режиме.

[Справочник команд](https://gitverse.ru/docs/ai/ai-assistant-gigacode/gigacode-cli/commands)
перечисляет `/model`, `/plan`, `/approval-mode` и `/mcp`.
[Документ о памяти](https://gitverse.ru/docs/ai/ai-assistant-gigacode/gigacode-cli/memory)
описывает `GIGACODE.md` и чтение `AGENTS.md`.

## Чего эти сведения не доказывают

Проверки установленного CLI и model call в рамках этого исследования не выполнялись.
Не закреплены версия, пакет поставки, флаги headless, ACP, формат событий, terminal
marker, resume/cancel, источник моделей, файловая изоляция и способ авторизации службы.
Интерактивная слэш-команда не доказывает её доступность в машинном транспорте.
Название режима `plan` не доказывает запрет записи файлов на уровне runtime.

На дату проверки в `server/src/lib/executors/` и `engine/lib/runners/` нет адаптеров
GigaCode. Возможности внешнего продукта не означают готовую поддержку в GrigDesk.
Границы двух каталогов описаны в
[подключении исполнителя](executor-adapter-boundary.md) и
[каталоге раннеров конвейера](../pipeline/runner-selection-boundaries.md).

Дальнейшие утверждения о совместимости должны сопровождаться версией CLI,
обезличенным протокольным примером и проверкой соответствующего пути исполнения.
