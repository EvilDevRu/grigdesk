# Этап фабрики на GLM: политика, ход и host-wrapper

Обычный чат GLM не меняется: прежний JSON политики без поля `consumer`, approval `ask`,
ревизии `grigdesk-glm-profile-v2`/`grigdesk-glm-policy-v1` и golden профиля байт в байт.
Этап фабрики — отдельный потребитель со своими ревизиями
`grigdesk-glm-factory-profile-v1`/`grigdesk-glm-factory-policy-v1`; допуск сборки DSH
проверяется прежней формулой identity для режима `api`.

## Политика этапа

- `glmFactoryPolicy`: `state-only` → sandbox `read-only`, `workspace-write` → `workspace-write`;
  approval всегда `never`, вопросов нет. Другой режим — `glm_factory_policy_unsupported`.
- Документ политики hook пишет только хост: `{format:1, consumer:'factory', filesystem,
  rawTools}`, где rawTools — ровно `mcp__factory-status__stage_progress` и `stage_result`.
  Hook различает потребителя до разбора: документ с ключом `consumer` идёт только в строгий
  parser этапа; лишний ключ, неполный или повторный inventory — отказ (exit 2).
- Решение этапа: статус — по точному имени (похожий префикс `factory-status-extra` запрещён),
  `ask_user_question` запрещён, в `state-only` запрещены `write`/`edit`, shell проходит
  строгую политику прямого SSH и клиентов БД.

## Ход этапа

- `runGlmTurn` принимает этап только с `factory:true` и typed `factoryContext` хоста: task,
  stage, run, epoch, файловый режим и единственный статусный MCP с абсолютной командой и
  совпадающими `FACTORY_RUN_*` в env. Без контекста, с чужим MCP, с sessionId, с чатовым
  режимом прав, в Coding Plan (`glm_factory_mode_unsupported`), scoped или untrusted — отказ
  до процесса и prompt.
- Монтируется только `factory-status` (`failOnStartupError`, без переподключения); его
  потеря — `glm_mcp_not_ready`, вызов без дескриптора hook — `glm_policy_hook_missing`.
- Вопрос и approval этапа получают отказ сразу, обработчик человека не вызывается.
- Home этапа — в `RUN_DIR/glm/runtime`, перенос прежних chat homes не выполняется.

## Host-wrapper и metadata

- `server/scripts/glmRunner.mts` (`runGlmFactory`) разделяет с DeepSeek общий модуль
  `server/src/lib/factoryProviderRunner.ts`: пары argv, private prompt в RUN_DIR, identity
  этапа из env, allowlist env статусного MCP, private `last.md`, вырезание ключей из ошибок.
  Режим доступа — только `api`; ключ Coding Plan не подставляется. Сверка
  `--runtime-identity`/`--runtime-version` с закреплённым ELF — до prompt (`glm_runtime_changed`).
  После SIGTERM/SIGINT событие `result` не публикуется. События не несут prompt и ключ.
- `server/scripts/glmRuntimeInfo.mts`: descriptor, `--probe` и `--catalog` без ключа, процесса
  DSH и модели. Probe требует `GRIGDESK_GLM_API_MODE=api` и допуск `api` в metadata ELF.
  `runnerVersion` = версия DeepSeek-runner + `.p<packageId>` + обе ревизии этапа.
- Каталог этапа статичен (проверенные модели zai и их уровни): glm-5.3, glm-5.3-flash,
  glm-5.3-highspeed (`low, high, max`), glm-5.2, glm-5.2-highspeed (`off, high, max`),
  glm-4.7, glm-5-turbo (`high`). Пустой уровень — штатный `high`.
- Оба скрипта — helpers каталога (`glm-runner` main, `glm-runtime-info` script) с обёртками
  прежних путей `server/scripts/*.mts` в staging; из перенесённого R без `server/src` probe
  возвращает версию, а runner без ключа API даёт `wrapper_error` `glm_key_missing`.

Проверено unit- и процессными тестами на фейковом транспорте DSH и metadata-двойнике ELF.
Shell-раннер движка, настоящие ходы на собранном ELF и статус в ledger проверяются отдельно.
