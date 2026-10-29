# Подтверждения MCP в Codex

Адаптер `server/src/lib/executors/codex.ts` явно передаёт
`approvalPolicy: 'on-request'` и `approvalsReviewer: 'auto_review'` при
`thread/start`, `thread/resume` и каждом `turn/start` режима `auto` обычного чата.
Это относится и к возобновлённой сессии: её прежняя политика не сохраняется
поверх явного параметра нового хода.

`approval_policy` и `approvals_reviewer` входят в список `OWNED` адаптера
нативных настроек `server/src/lib/executorSettings/codex.ts`. Форма дополнительных
настроек не служит вторым редактором этих параметров. Изменение пользовательского
значения по умолчанию также не отменяет параметр, явно переданный адаптером.

Служебный чат с `workspaceAccess` явно использует `never/user`, а изолированный
untrusted runner сохраняет `never`. В этих режимах MCP-инструмент, которому Codex
требует подтверждение, может быть отклонён до вызова сервера:

```text
MCP tool call requires approval, but approval policy is never
```

Такой отказ не доказывает отсутствие прав к внешнему ресурсу. Разные инструменты
одного MCP могут иметь разные требования: успешное чтение или создание файла
не означает, что последующий вызов редактирования обойдётся без подтверждения.

## Поддержка запросов в адаптере

Адаптер отдельно обрабатывает `mcpServer/elicitation/request` и `item/tool/call`.
Ручные запросы commandExecution/fileChange/permissions получают RPC error.
Собственный неожиданный запрос закрывает app-server: завершения только локального
Promise недостаточно для остановки native действий. Чужой thread/turn не прерывает
родителя. Native Auto-review принимает решение внутри Codex; GrigDesk не отправляет
accept/override. Это не поддержка ручных интерактивных подтверждений.

До первого turn адаптер проверяет effective policy/reviewer и тип sandbox в ответе
start/resume. Несовпадение закрывает процесс без запуска turn и без сброса thread id.
Native решения сохраняются заметкой с action/status/rationale; одиночный denied
не запрещает модели продолжить безопасным действием.

Команда `/approvals` в каталоге Codex имеет `run: 'none'` и подсказку
«Исполняется только в TUI Codex». Она не переключает политику чата GrigDesk.

## Независимая терминальная сессия

Интерактивный Codex CLI поддерживает сочетание
`--sandbox workspace-write --ask-for-approval on-request`: пользователь может
отвечать на запросы в терминале. Это отдельный запуск с собственной политикой,
а не изменение работающей сессии GrigDesk. Настройки и доступность MCP следует
проверять в его окружении; `/mcp` показывает активные серверы.

Параметры описаны в [официальной документации CLI](https://learn.chatgpt.com/docs/developer-commands?surface=cli),
проверка подключений — в [документации MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
