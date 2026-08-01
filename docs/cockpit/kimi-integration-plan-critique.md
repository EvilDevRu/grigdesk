# Критика плана интеграции Kimi

Дата разбора: 2026-08-01. Исходный документ: [план интеграции Kimi](./kimi-integration-plan.md).

## Вердикт

Выбор актуального Kimi Code через ACP выглядит разумно, а основные риски названы честно.
Но документ пока остаётся аудитом и направлением исследования, а не исполнимым production-планом:
часть критических оговорок из раздела 0 не перенесена в этапы, тесты и критерии готовности.

До реализации нужно переписать порядок работ вокруг трёх границ: server-owned session binding,
обязательного `KimiRuntime/SandboxRunner` и запрета повторного prompt после неопределённого исхода.

## P0 — блокеры

1. **Критические оговорки не превращены в работы.** [Раздел 0](./kimi-integration-plan.md:14)
   требует поправить план до реализации, но последующие этапы всё ещё описывают старые контракты.
   Каждое замечание должно появиться в конкретном этапе, тесте и acceptance criterion.

2. **`modelRef` и session binding не спроектированы как server-owned state.** Не определены версия
   схемы истории, миграция старых чатов, защита binding от позднего PUT со второго устройства,
   rollback и поведение одинаковых model ID у разных провайдеров. Сначала нужен versioned
   `sessionBinding` с `revision/generation`, который клиент не может переписать напрямую.

3. **`session/list({cwd})` не доказывает принадлежность сессии чату.** Проверка из
   [раздела sessions](./kimi-integration-plan.md:157) подтверждает только cwd. Два чата одного
   worktree остаются взаимозаменяемыми. Resume должен брать ID только из server binding, а
   блокировка хода — работать по `{provider, sessionId}`, не только по клиентскому `chatKey`.

4. **Experimental spike и безопасный MVP смешаны.** [Security gate](./kimi-integration-plan.md:233)
   разрешает manual-only без containment, а критерии готовности допускают его как результат MVP.
   Нужны три разных результата: небезопасный opt-in spike, MVP только после containment gate и
   отдельный production/default rollout gate. Поведенческий тест CLI не заменяет OS boundary.

5. **Containment стоит слишком поздно.** Выбор container/cgroup, отдельного UID или brokered FS
   меняет spawn, cwd, HOME, auth, вложения, MCP и cleanup. Сразу после spike должен появиться
   единый `KimiRuntime/SandboxRunner` без обходного пути; ACP executor строится уже поверх него.

6. **Граница секретов неполна.** Отдельный user/container сам по себе не скрывает Kimi credential
   от shell-потомка в том же namespace. Нужны минимальный env allowlist, изолированные HOME/XDG и
   sockets, учёт `SSH_AUTH_SOCK`, credential helpers, npm/cloud/proxy токенов и честно записанный
   остаточный риск Kimi credential.

7. **Нет модели network egress.** Файловая песочница не мешает shell, MCP или hook отправить код
   произвольному хосту. Нужны network namespace/proxy/allowlist либо явный запрет production на
   чувствительных данных при unrestricted egress.

8. **Автозагрузка Kimi-конфигурации не закрыта.** User/project hooks, plugins, MCP, skills и
   инструкции названы как риск, но не включены в реализацию. Cockpit нужен sanitised
   `KIMI_CODE_HOME`, startup inventory и явный allowlist; неизвестная версия CLI должна давать
   отказ запуска, а не предупреждение.

9. **Generic retry после prompt опасен.** Риск описан, но текущий chat core умеет повторять
   `emptyRun`. Для Kimi retry допустим только до доказанной отправки `session/prompt`; после неё
   потеря транспорта должна завершаться как `ambiguous_outcome`. Нужен adversarial-тест:
   действие выполнено, ответ потерян, prompt повторно не отправлен.

10. **`default` и `plan` преждевременно названы безопасными.** До допуска нужна снятая на
    зафиксированной версии матрица «режим × tool × permission timing × read/write/network».
    `plan` всё равно может читать и отправлять код модели.

## P1 — архитектурные пробелы

1. Interaction broker описан двумя контрактами. Нужен один run-scoped API с `runId`, `sessionId`,
   `toolCallId`, generation, одноразовым ответом, проверкой option ID, abort/timeout cleanup,
   лимитами размера и защитой от позднего ответа прошлому run.

2. Нельзя монтировать общий `chats/attachments`: один чат увидит вложения другого. Для каждого
   run нужен отдельный read-only staging root только из перечисленных regular files, с
   `O_NOFOLLOW`, лимитами и retention policy.

3. Stop должен завершать cgroup/process namespace, а не один child PID. Требуются PID/CPU/RAM/
   disk/output budgets, startup cleanup после падения Cockpit и тесты отвязавшегося фонового
   потомка и MCP child.

4. Не доказаны flush/exit semantics ACP. Этап 0 должен проверить EOF, SIGTERM и timeout с
   последующим resume и отсутствием повреждения session state.

5. Runtime-каталог `configOptions` не имеет схемы хранения, TTL, account/profile fingerprint и
   invalidation после login/logout/update. Нужна двухфазная проверка: bootstrap precheck, затем
   обязательная сверка option IDs после `session/new` и до prompt.

6. Scope «только `/chats`» нельзя обеспечивать клиентским `context.path`. Нужно либо поддержать
   Kimi во всём chat subsystem, либо создать отдельную server-side capability/endpoint для этой
   поверхности.

7. Нельзя молча сводить несколько вопросов к одному или multi-select к single-select. Такая форма
   должна завершаться как `unsupported_interaction` либо показываться полностью и отменяться.

8. Rollback — это не только feature flag. Нужна совместимость старого кода с новой историей либо
   versioned migration с backup/restore; выключение Kimi не должно делать чаты нечитаемыми.

9. Region, retention, telemetry, training policy и допустимость отправки исходников должны стать
   pre-GO checklist и операторской документацией, а не открытым вопросом в конце плана.

## P2 — корректность и эксплуатация

- Отдельно доказать fixtures-тестом, что `session/resume`, как и `session/load`, не replay-ит
  старые updates в UI.
- Устранить противоречие смены модели: до первого prompt выбор применяется, после начатой сессии
  создаётся новый binding без resume старого ID.
- Задать лимиты ACP frame/stdout, partial updates, tool input, handshake/idle/turn timeout,
  CPU/RAM/PID/disk и отдельный режим ресурсов `waiting_for_user`.
- Добавить smoke-сценарий неопределённого результата с безопасным маркерным файлом.
- Убрать просмотрщик документов из плана Kimi, кроме одной строки «не входит»: это независимый
  core-модуль и отдельный релиз.

## Рекомендуемый новый порядок

1. Versioned server-owned chat binding и миграционные/rollback-тесты.
2. Обезличенный ACP spike: lifecycle, replay, modes/tools, config autoload, flush и error taxonomy.
3. Threat model и решение GO/NO-GO по FS, secrets, process tree и network egress.
4. Обязательный `KimiRuntime/SandboxRunner` с budgets и per-run attachments.
5. Provider-neutral interaction broker с run-scoped identity.
6. ACP executor без retry после prompt и с lock по provider/session.
7. Runtime capabilities/catalog, UI и только затем controlled rollout.

Главный критерий: experimental spike может завершиться полезным `NO-GO`, но production MVP не
может считаться готовым без доказанной OS/process/network boundary и server-owned session identity.
