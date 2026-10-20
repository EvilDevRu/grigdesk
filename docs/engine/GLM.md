# GLM на этапах Factory: контракт раннера и границы

GLM исполняет этапы конвейера тем же DSH ELF (`bin/deepseek`), что и DeepSeek, но через
отдельный раннер `engine/lib/runners/glm.sh` и host-wrapper `server/scripts/glmRunner.mts`.
Общий порядок добавления раннера — [ADDING-RUNNER.md](ADDING-RUNNER.md); политика этапа и
ход GLM — [этап конвейера GLM](../grigdesk/chat/glm-factory-stage.md).

## Что объявляет раннер

| Метод | Поведение |
| --- | --- |
| `probe` | `glmRuntimeInfo.mts --probe`: допуск `api` по metadata ELF, без ключа модели. Coding Plan, пустой режим или нет ELF → `4`; offline → `126`. |
| `catalog` | Семь проверенных моделей маршрута `zai` из `glm/factoryCatalog.ts`, provider `glm`. |
| `capabilities` | `status status_request tools structured_output`. Sandbox, fanout и native resume не заявлены. |
| `default_policy` | `FAMILY=default`, `EFFORT=high`; `family_alias` — `4`. |
| `run` | Только `GRIGDESK_GLM_API_MODE=api`; режимы ФС `state-only→read-only`, `workspace-write`. |
| `classify` | `0→ok`, `124→timeout`, всё остальное `unknown`. |
| `fanout_count` | Разбор retained JSON; повреждённый поток — отказ, а не `0`. |
| `interrupt` | `0`: wrapper и DSH живут в setsid-сессии launcher-а. |

Версия раннера — `<runtimeVersion DSH>.p<packageId>.<ревизия профиля>.<ревизия политики этапа>`.
Замена ELF или ревизий меняет её, поэтому прежнее покрытие даёт `runtime_changed`, а не
продолжение на другой поставке.

## Запуск этапа

Descriptor metadata-helper-а — единственный источник ELF, identity, `runtimeVersion`, версии
раннера, кэша и каталога моделей. Модель и уровень сверяются с ним до записи prompt; уровень
вне списка модели, модель другого маршрута и смена версии после preflight отвергаются без
запуска wrapper-а. Prompt — private-файл `RUN_DIR/glm/prompt.md`, home этапа —
`RUN_DIR/glm/runtime`. Ключ, prompt и status identity в argv не попадают;
`RUNNER_GLM_ADD_DIRS` — только prompt-контекст, не writable root DSH.

Node и ELF — общая host-поставка DSH: `GRIGDESK_DEEPSEEK_NODE_BIN`/`NODE_BIN` и
`GRIGDESK_DEEPSEEK_BIN`, кэш — `GRIGDESK_DEEPSEEK_CACHE_DIR`. Отдельного CLI `glm` нет:
basename `glm|glm-*` заблокирован OFFLINE_GUARD, а `tests/engine/fakes/bin/glm` — tripwire `97`.

## Окружение и ключи этапа

Сервер передаёт движку `GRIGDESK_GLM_API_MODE` (только `api`/`coding-plan`, иначе пусто) и
host-owned пути: PATH с каталогом установки первым, Node и ELF DSH, кэш, `FACTORY_HOME`,
профили. `extraEnv` их не подменяет и не может внести модельный ключ. `ZAI_API_KEY` и
`DEEPSEEK_API_KEY` идут юниту файлом `route-secrets.env` 0600, отвязанному процессу — его
окружением; `ZAI_CODING_API_KEY` не передаётся ни одной веткой.

## Классификация и диагностика

Живой spike GLM этапа не выполнялся, платный live запрещён. Поэтому ни одна сигнатура не
переключает провайдера: 401 до и после работы, 429, 413, обрыв потока и ошибки wrapper-а
остаются `unknown`. Offline-fixtures `tests/engine/fixtures/classifiers/glm-*` помечены
`SOURCE=fixture`. Отказ wrapper-а (`wrapper_error`) попадает в `FAILURE_CODE/MESSAGE/DETAIL`
через retained finalizer `runtime-usage.mjs`; код вне `^[a-z][a-z0-9_]{0,63}$` становится
`unknown`, секреты в сообщении скрываются. Карточка остановки (`runnerStall.ts`) читает
mirror, а у старых запусков — то же событие из `events.jsonl`. Usage dialect — `glm-jsonl-unknown`: расход
`unavailable/missing`, не нулевой billing.

## Проверки

`tests/server/glm-runner-contract.test.js` запускает shell-тесты движка штатным воркером
`run-offline.sh --one` (свой `TEST_ROOT`, `FACTORY_FORBID_LIVE=1`): `unit/glm-runner.sh`,
`unit/glm-runner-launch.sh`, `integration/glm-runtime-stop.sh`, регистрацию в
`contract/runner-contract.sh` и `classifier-fixtures.sh`, `symmetric-failover.sh`,
`runtime-switch.sh`, `runner-failure-detail.sh`. Настоящий модельный ход GLM этапа
проверяется только на собранном серверном ELF с loopback-моделью.
