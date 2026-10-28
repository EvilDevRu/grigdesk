# Штатные разрешения Harness и граница оценки опасности

Проверено по закреплённым исходникам `deepseek/vendor/deepseek-harness/upstream/`.
Политика файлов и согласование расширения доступа — независимые механизмы Harness:

- `sandbox-policy` с `mode: workspace-write` разрешает изменения внутри realpath cwd
  сессии и временных областей, предоставленных backend песочницы.
- `user-approval` с `policy: ask` передаёт уже возникшие запросы подтверждения человеку.
  Сам по себе этот параметр не создаёт запрос перед каждым инструментом.
- `tool-bash` передаёт обычную команду в `bash-sandbox`, который применяет файловую
  песочницу ко всему запущенному процессу. Отказ возвращается результатом команды.
- Явная пара `sandbox_permissions` и `justification` проходит через общий
  `approveEscalation` до запуска. Только `allowed-once` разрешает расширение для этого
  вызова; standing policy сессии при этом не меняется.
- `permission-presets` объединяет эти параметры. Штатный `workspace-write` — это
  `sandbox: workspace-write` и `approval: ask`, а не отключение подтверждений.

В этой версии нет встроенного классификатора опасных shell-команд. Файловая граница
не различает обычную правку и рекурсивное удаление внутри разрешённой папки; сеть и
управление процессами вообще не входят в словарь `SandboxMode`. Обещать подтверждение
любых опасных действий только на основании `workspace-write + ask` нельзя.

Deployment-проверки Harness предлагает подключать через `tools/pre-execute`;
об этом прямо говорит комментарий в `packages/shell/tool-bash/src/index.ts`.
Это отдельная политика, а не скрытая возможность `approval: ask`.

В Codex адаптер GrigDesk задаёт `workspace-write`, `approvalPolicy: on-request`
и `approvalsReviewer: auto_review`; effective значения проверяются до начала хода.
Обычные sandbox-команды не отправляются в общий классификатор GrigDesk. Auto-review
решает возникшие native запросы, а не оценивает каждый shell-вызов. Harness предоставляет
`workspace-write + ask`, но не имеет параметра reviewer: его эскалацию решает человек.
Подробнее — [режимы Codex](codex-permission-modes.md).

В auto DeepSeek gate передаёт доверенный штатный bash этой native цепочке,
сохраняя deny/ask других native listeners. Default по-прежнему спрашивает перед shell,
read-only отказывает. Runtime-проверки сохраняют выбранную sandbox и approval policy
даже после resume с более широкими persisted overrides.

Точки проверки: `packages/sandbox/sandbox-policy/src/index.ts`,
`packages/sandbox/sandbox/src/escalation.ts`, `packages/shell/tool-bash/src/index.ts`,
`packages/shell/bash-sandbox/src/index.ts`,
`packages/interaction/user-approval/src/index.ts` и
`packages/interaction/permission-presets/src/index.ts` внутри upstream snapshot.
