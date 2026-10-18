# Факты runtime GLM на настоящей сборке DSH

Факты проверены тестами «настоящий …» на собранной generation с плагином `llm-pi-ai`
и фейковой моделью Z.ai на loopback. Внешний fetch в процессе запрещён, ключ синтетический.
Тесты остаются регрессией и входят в compiled-parity.

## Маршрут и модель

- Без `llm-deepseek` ACP `session/new` с моделью `zai/glm-5.3` в строке `acp` (web —
  `agent-default-model`) отдаёт эту модель текущей; модельных запросов нет.
- Запрос уходит на `<baseURL>/chat/completions` с моделью и `Authorization: Bearer` значением
  переменной из `apiKeyEnv`. Переопределённый `baseURL` сохраняет compat `zai`:
  `tool_stream: true`, при effort — `thinking: { type: enabled, clear_thinking: false }`.
- Без effort на wire уходит `thinking: { type: disabled }` у всех семи моделей: отсутствие
  effort молча выключает рассуждение.
- Уровни ACP `reasoning_effort` после выбора модели: glm-4.7 и glm-5-turbo — `off, minimal,
  low, medium, high` (без `xhigh`); glm-5.2 и glm-5.2-highspeed — `off, high, max`; glm-5.3,
  glm-5.3-flash, glm-5.3-highspeed — `low, high, max`. У всех первым идёт пустое значение
  «Provider default», равное отсутствию effort.
- Web-RPC `session/selectModel` с `provider`, `model`, `reasoningEffort` отвечает
  `{ selected }`; неподдерживаемый effort и неизвестная модель — ошибка
  `session/model-unavailable`. Обратное чтение до prompt — snapshot `session/follow`,
  `projections.values.modelSelection.next`.
- Секция `llm-pi-ai` в settings-документе процесса переопределяет маршрут (`baseURL`) на
  следующий запрос; поэтому документ процесса GLM должен принадлежать серверу.
- Клиент представляется `user-agent: deepseek-harness/<версия> (+https://github.com/deepseek-ai/deepseek-harness)`.

## Ошибки и повторы

- `dsh-llm-retry` исполняет `retryPolicy` маршрута; сорванное до ответа соединение pi-ai сообщает
  как «Connection error.» и относит к `TRANSPORT`, который повторяется по умолчанию.
- При `retryPolicy: { mode: normal, maxRetries: 0 }` ответ 429 и обрыв потока дают ровно один
  запрос. Ошибка модели приходит в `turn/end` как `reason.kind: error` с `reason.error.code`;
  HTTP-статуса нет.
- Коды: 401 и 403 — `AUTH`; 402 и любой ответ с текстом о нехватке баланса (в том числе 429) —
  `QUOTA`; 429 с текстом rate limit — `RATE_LIMIT`; обрыв потока — `TRANSPORT`.

## Hooks и approval

- PreToolUse с matcher `*` получает точные `tool_name`, `tool_input` (уже разобранный объект,
  в том числе после дробных аргументов) и `tool_use_id`, равный `callId` вызова — для
  read, edit, bash и MCP. Hook завершается раньше `approval/request` того же вызова.
- Канал hooks fail-open: exit 1, падение и таймаут пропускают вызов, блокирует только exit 2.
  Испорченный `hooks.json` не регистрирует ни одного hook, ход идёт без них.
- Hook выполняется в песочнице процесса: писать он может только в рабочую область и в
  приватный `/tmp` песочницы, файл вне них недоступен (`EROFS`). Наблюдаемый GrigDesk канал —
  событие `hook/result` в `session/follow`: `point`, `turn`, `exitCode`, `decision` и
  `stderrSummary` (stderr hook, предел задаёт `stderrSummaryMaxChars`). Событие
  `UserPromptSubmit` приходит до первого `tool/call` хода; без hooks его нет.
- В `workspace-write` с `approval: ask` DSH не спрашивает approval ни для read, write, bash, ни
  для MCP-инструментов; approval приходит только на явную эскалацию песочницы
  (`sandbox_permissions`). `approval/request` несёт `toolName`, `callId`, `reason`.

## Профиль и инструменты

- Web-профиль без строки `web` не создаёт сессию: штатный preset падает с
  `agent-preset/invalid` (`tool-web` ждёт сервис `web`). Строки `web`, `web-search-deepseek`,
  `web-fetch-http` остаются, а инструменты `web_search` и `web_fetch` запрещает политика hook.
- Инструменты web-профиля в запросе модели: `ask_user_question, bash, create_goal, edit,
  exit_plan_mode, get_goal, glob, grep, interrupt_agent, job_kill, job_list, job_output,
  list_agents, present, ralph, read, read_image, send_message, skill, subagent, subagent_fork,
  todo_write, update_goal, web_fetch, web_search, workflow, write`.

## MCP

- Имя инструмента — `mcp__<server>__<tool>`. Если нормализация до `[A-Za-z0-9_-]` что-то
  заменила или имя длиннее 64, берутся первые 51 символ нормализованного имени, `_` и
  `sha256("<server>\0<tool>")[:12]`. Серверы `a__b` с инструментом `c` и `a` с `b__c` дают одно
  имя `mcp__a__b__c`: инструмент второго сервера отвергается целиком.
- Адрес web-процесса выдаётся только после `initialize` и `tools/list` каждого stdio-сервера.
  С `failOnStartupError: true` сломанный `initialize` завершает процесс до старта
  («plugin tree failed to load»), prompt не отправляется. Это сигнал готовности до prompt.
