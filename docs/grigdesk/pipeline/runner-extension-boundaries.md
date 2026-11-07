# Границы подключения раннера: effort, статус, fanout и диагностика

Проверено по исходникам 18 октября 2026 года. Обнаружение shell-модуля само по себе
не подтверждает все возможности маршрута. Общий порядок подключения описан в
[`ADDING-RUNNER.md`](../../engine/ADDING-RUNNER.md), граница UI-каталога — в
[каталоге раннеров](runner-selection-boundaries.md).

## Неявный effort разрешает диспетчер

В `engine/lib/multi-runner.sh`, `_multi_resolve`, пустое значение
`MODEL_<STAGE>_<PROVIDER>_EFFORT` / `MODEL_DEFAULT_<PROVIDER>_EFFORT` заменяется на `high`.
`runner_<id>_default_policy` вызывается лишь при отсутствии и FAMILY, и EXACT;
в этой ветке он также заменяет effort своим значением.

Поэтому пустой effort в `default_policy` не доказывает запуск модели без effort:
при заданном EXACT или FAMILY диспетчер передаст `high`. Проверка только прямого
вызова `runner_<id>_run` с пустым аргументом эту границу пропускает. Нужна проверка
через `_multi_resolve` с действительным конфигом профиля и наблюдением параметров CLI.

`server/src/lib/runnerState.ts`, `modelPolicy`, читает effort из профиля без этой
подстановки. Подпись политики до запуска и фактическое значение попытки поэтому
могут различаться; историческая попытка должна показывать собственные metadata.

## Статус требует полного протокола стадии

`engine/lib/stage-result.sh` и `status-request.sh` принимают `done|skipped|failed`.
`human` является `failureOwner` typed-отказа, а не значением result.
Нетерминальные данные передаются отдельно через `stage-progress.sh`.
Форма findings и разрешённые ключи progress закреплены в
[контракте профиля](../../engine/PROFILE-CONTRACT.md#status-protocol-v2).

MCP-пример `server/scripts/deepseekStatusMcp.mts` передаёт progress, failure owner,
blocking/deferred findings, anchors и reviewed scope. В его списке аргументов result
нет `--next-stage`, `--stage-closed`, `--stage-summary`, существующих у `stage-result.sh`.
Поэтому копирование этого MCP не доказывает поддержку роли ведущего многоэтапного цикла.

Роль приходит в `FACTORY_LOOP_ROLE` из `route-runtime.sh`. В `attempt-stage-state.sh`
граница следующего этапа требует `failed`, blocking findings следующего этапа,
список закрытых findings и однострочный итог предыдущего. Обычный успешный `done`
не является проверкой передачи этой границы.

## Fanout проверяется до исполнения

`_multi_execution_plan` в `engine/lib/multi-runner.sh` преобразует требование узла
в необходимые capabilities:

| Требование при отсутствии capability `fanout` | Уровень выполнения |
|---|---|
| single, max=1, degrade=forbid | native |
| parallel, допустимый max, degrade=forbid | unavailable |
| parallel, допустимый max, degrade=allow-single | degraded |

Обязательный метод `fanout_count` и capability `fanout` имеют разный смысл:
метод отвечает за учёт, capability — за допуск узла. Успешный single-узел не
доказывает возможность назначить того же исполнителя на parallel-узел.

## Причина ошибки не зависит от наличия расхода

В текущем `engine/lib/runtime-usage.mjs`, `prepare`, поле `failure` извлекается
из удержанного событийного потока только для Codex. Затем host finalizer формирует
`FAILURE_CODE`, `FAILURE_MESSAGE`, `FAILURE_DETAIL` в диагностическом `meta.env`;
`_multi_invoke` читает оттуда `DISPATCH_INVOKE_DETAIL`.

Новый parser провайдера или строка в stderr не подключают эту цепочку автоматически.
Доставка причины отказа и нормализация billing counters — разные задачи: отсутствие
счётчиков не должно означать отсутствие пояснения человеку. Владельцем meta остаётся
host finalizer; адаптер не дописывает его параллельно. Подробности —
[диагностика остановки](runner-failure-diagnostics.md).
