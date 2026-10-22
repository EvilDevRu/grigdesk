# Kimi host: причина прежней блокировки ходов с плагином БД

В server transport исправление реализовано через [канал команд GrigDesk](kimi-command-policy.md):
встроенный Bash глобально закрыт, отдельный MCP проверяет SSH/БД до запуска команды.
Включённый плагин БД больше не останавливает обычный текстовый ход. Внутренний ACP host
с активной политикой сохраняет прежний отказ. Ниже сохранены причина и исследование ошибки.

В прежней реализации ошибка `direct_db_policy_unavailable` возникала до запуска Kimi и отправки prompt.
Она не зависела от того, упоминает ли сообщение базы данных, и не означала попытку
подключиться к БД.

В `server/src/modules/chat/index.ts` сервер собирает настройки запуска и присваивает
`blockDirectDb: fastify.pluginEnabled?.('db') === true` после сохранённых настроек
исполнителя. Поэтому включение плагина БД включает политику для каждого хода, даже
без открытой DB-сессии; сохранённое значение исполнителя не переопределяет её.
`strictClientPolicy` задаёт отдельную строгость разбора неизвестных клиентов и не
отключает `blockDirectDb`.

`server/src/config.ts` по умолчанию выбирает для Kimi `host`.
Прежний `server/src/lib/kimi/runtime.ts` при сочетании `host` и `blockDirectDb === true`
отклонял запуск: host-адаптер не обеспечивал требуемый запрет прямых подключений.
Этот отказ для внутреннего ACP по-прежнему закреплён тестом
`host runtime при DB-политике отказывает до запуска во всех режимах прав`
в `tests/server/kimi-runtime.test.js`.

Сетевая изоляция Kimi выбирается через
`GRIGDESK_KIMI_LAUNCH_MODE=contained` в окружении сервера и применяется после его
перезапуска человеком. Это отдельный профиль с проверкой версии, preflight,
ограниченной сетью и другой привязкой сессии, а не переключатель режима «Авто».
Ограничения и требования описаны в [security gate Kimi](kimi-runtime-security.md).

Другой вариант продолжить работу с включённым плагином БД — исполнитель с реализацией
политики команд. Общий контракт перечислен в
[runtime-контрактах](../reference/runtime-contracts.md).

## Недостающая интеграция проверки команд

Git-история связывает добавление DB-отказа с реализацией надзорного плагина БД:
commit `6a4330f81` добавил проверку до запуска и тест, требующий этот отказ во всех
режимах. Тест закрепляет остановку Kimi, но не проверяет сценарий «обычный вопрос
работает при включённом плагине, запрещённая команда отклоняется отдельно».

Это было ограничением адаптера GrigDesk. В исходниках Kimi Code тега
`@moonshot-ai/kimi-code@0.33.0` уже есть `PreToolUse`:

- `packages/agent-core/src/agent/permission/policies/index.ts` ставит
  `PreToolCallHookPermissionPolicy` первой, перед `auto`, запомненными разрешениями
  и `yolo`;
- `packages/agent-core/src/agent/permission/policies/pre-tool-call-hook.ts`
  передаёт имя инструмента и аргументы, возвращая отказ только этому инструменту;
- `packages/agent-core/src/session/hooks/runner.ts` принимает JSON с
  `hookSpecificOutput.permissionDecision: "deny"` при exit 0, а также exit 2.
  Общий обработчик GrigDesk `_direct-ssh-policy-hook.js` уже выдаёт такой JSON.

GrigDesk не использует этот hook как рубеж и не устанавливает его в host-конфигурацию Kimi. Обработчики ACP reverse
permission и server approval не заменяют `PreToolUse`: автоматическое разрешение или
запомненное решение могут не довести отдельное действие до этих обработчиков.

У нативного hook есть существенный предел: невозможность запуска, авария и timeout
дают `allow`; `HookEngine.trigger` также поглощает исключения. Поэтому наличие hook
само по себе не доказывает запрет при отказе инфраструктуры и не даёт сетевую изоляцию.
Это подтверждается исходниками указанного тега и
[документацией Kimi](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html).

Источник порядка проверок:
[policies/index.ts версии 0.33.0](https://github.com/MoonshotAI/kimi-code/blob/%40moonshot-ai%2Fkimi-code%400.33.0/packages/agent-core/src/agent/permission/policies/index.ts).
Источник обработки отказов:
[hooks/runner.ts версии 0.33.0](https://github.com/MoonshotAI/kimi-code/blob/%40moonshot-ai%2Fkimi-code%400.33.0/packages/agent-core/src/session/hooks/runner.ts).

## Нативный запрет инструмента

В этой же версии глобальный `[tools].disabled = ["Bash"]` применяется ко всем агентам
и проверяется повторно перед исполнением. Это отдельный механизм от permission hooks:
`packages/agent-core-v2/src/agent/toolPolicy/toolPolicyService.ts` устанавливает guard
исполнителя, а `evaluate.ts` пересекает глобальные ограничения с профилем и сессией.
Семантика описана в
[конфигурации Kimi 0.33.0](https://github.com/MoonshotAI/kimi-code/blob/%40moonshot-ai%2Fkimi-code%400.33.0/docs/en/configuration/config-files.md#tools).

На установленном бинаре с синтетическим home, без запроса модели, подтверждено:
`GET /api/v1/tools?session_id=...` для созданной сессии возвращает запись Bash с
`active: false` при таком запрете. REST-конфигурация `/api/v1/config` не предоставляет
поле `tools`; запрет требуется записывать в TOML до старта процесса. Это проверка
возможности нативного механизма, а не свидетельство готовой интеграции GrigDesk.

Для старой сессии после перезапуска процесса `/tools` сначала возвращает пустой
список: маршрут обращается только к живой сессии. `GET /sessions/{id}` читает
метаданные, но не загружает её. `GET /sessions/{id}/snapshot` загружает сессию;
после него `/tools` снова отражает эффективные ограничения. Это подтверждено
на синтетической сессии без запроса модели и соответствует реализации
[routes/tools.ts](https://github.com/MoonshotAI/kimi-code/blob/%40moonshot-ai%2Fkimi-code%400.33.0/packages/kap-server/src/routes/tools.ts)
и [routes/snapshot.ts](https://github.com/MoonshotAI/kimi-code/blob/%40moonshot-ai%2Fkimi-code%400.33.0/packages/kap-server/src/routes/snapshot.ts).
