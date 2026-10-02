# GLM: повторное ревью границ допуска

Сверено 01.10.2026 отдельным критиком и автором доработки по текущему дереву Cockpit
и исходникам OpenCode `v1.18.34`. Объект — [план TDD](glm-integration-tdd-plan.md),
уже прошедший [первое ревью](glm-plan-review.md). Найдены три пробела P1 и три
несогласованности P2. Исправления ниже внесены в план; реализация, runtime, модельные
запросы и реальные MCP в этом ходе не запускались. Все этапы S00–S14 остаются открытыми.

## ACP не доказывает происхождение инструмента

[ACP tool conversion](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/acp/tool.ts#L124)
передаёт обобщённые title/kind и аргументы, но теряет exact tool name и происхождение MCP.
Заголовок non-shell инструмента может происходить из модельного текста.
[Permission bridge](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/acp/permission.ts#L61)
использует тот же преобразованный toolCall. Для MCP
[исходный permission request](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/session/tools.ts#L402)
получает пустой metadata. Восстанавливать allowlist, `external_directory` или принадлежность
`cockpit-work` по title/kind нельзя.

При этом [native/MCP pre-tool hooks](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/session/tools.ts#L102)
получают tool/session/call и аргументы до execute, а
[Plugin.trigger](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/plugin/index.ts#L284)
ожидает их callback. Обычные event hooks вызываются без ожидания; ошибки загрузки plugin
подавляются. Следовательно, наличие plugin-файла или асинхронного события не доказывает
отказ до эффекта. Exact MCP provenance также не следует из одного нормализованного tool ID.

**P1, S01/S07/S12:** spike обязан найти конкретный достоверный источник exact identity,
permission type и сырых MCP tuples, доступный до эффекта. Его схема и корреляция
`sessionId/callId` фиксируются в контракте; pre-tool канал ожидает явный acknowledge/deny.
Нет источника/handshake либо данные не совпали — отказ. Проверки включают поддельный title,
одинаковый kind разных tools, внешний файл и tool без ACP permission ask. Это расширяет
серверный hook до allowlist/provenance, сохраняя общую SSH/БД-policy. Совместимость такого
канала остаётся обязательным gate реализации; ревью её не подтвердило.

## MCP keys могут столкнуться со служебным инструментом

[McpCatalog](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/mcp/catalog.ts#L117)
нормализует server/tool names и соединяет их подчёркиванием.
[Общий tool map](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/mcp/index.ts#L674)
записывает результат по полученному ключу; поздняя запись заменяет прежнюю.
Две сырые пары дают одинаковый runtime key:

```text
cockpit-work            + supervised_ssh
cockpit-work_supervised + ssh
```

[Reader проектных MCP](../../../server/src/lib/deepseek/projectMcp.ts) запрещает точные
reserved names, поэтому второе имя проходит эту проверку. Статическая таблица Cockpit
не доказывает, какой клиент фактически исполняет инструмент под общим runtime key.

**P1, S12:** до prompt проверить все сырые tuples, нормализованные keys и native allowlist.
Optional colliding MCP исключается целиком с безопасным предупреждением; если единственность
обязательного MCP не доказана, prompt запрещён. Нельзя выбирать первого/последнего владельца.
При изменении tools-list inventory инвалидируется до повторной discovery. Настоящий
runtime-тест с указанной коллизией проверяет нулевой счётчик проектного сервера и точный
служебный descriptor. Hook/provenance gate остаётся обязательным и после первоначальной discovery.

## Live smoke выдаёт допуск только своему режиму доступа

**P1, S02/S09/S14:** прежний план проверял выбранный `api` либо `coding-plan`, затем открывал
общий production `run` для обоих. Исправление — `releasedAccessModes` в поставленном
`contract.ts`, изначально пустой. Offline проверяются оба кандидата; production auth/run
допускают только режим с собственными runtime/live доказательствами. Ни ключ, ни env/prefs
не расширяют этот список. Изолированный installation probe остаётся доступен карточке:
он доказывает установку, не выполняет model prompt и не выдаёт допуск.

Основная первая поставка требует live `api`; Coding Plan остаётся недопущенным до своего
smoke. Итог фиксирует обе строки таблицы допуска. Проверка API не объявляет подписку готовой.

## Уточнения порядка TDD и входного контракта

| Приоритет | Проверенный пробел | Правка |
| --- | --- | --- |
| P2 | S07 требовал настоящий chat route до создания `run` в S09 | S07 проверяет translator и standalone runtime hook; те же auto/comment/late-allow сцены проходят route в S12 |
| P2 | `allowedMode()` передаёт отсутствие/неизвестный mode как `''`, а preflight не определял его | `undefined`/`''` означают безопасный `default`; прямой plan/bypass/unknown отклоняется, route проверяет результат нормализации |
| P2 | Runner/fake model требовались в S01 без назначения этапа их создания | Fake model создаётся в S00; runner/protocol test и tsconfig include — в S01, затем накопленные gates S04–S14 |

Первый факт о modes проверен в
[общем чате](../../../server/src/modules/chat/index.ts): `allowedMode()` и `runArgs.permissionMode`.
Адаптер не может восстановить исходный unknown mode после его нормализации ядром.
Для проверок runner список обязательных сценариев задаётся по `--stage`, а не существующим
файлам. Недостающие/неверные артефакты, сценарии или сетевой рубеж дают ненулевой exit code.
После S04 ранние сценарии повторяются через production launcher с DI; исследовательская
обёртка S01 не является доказательством production-профиля.

Ревью уточняет необходимые доказательства и порядок работ. Если gate exact identity,
изоляции, cancel/resume или обязательного MCP не пройден, default остаётся setup-only.
Зелёный parser, fake ACP и проверка исходников не заменяют runtime/live приёмку.
