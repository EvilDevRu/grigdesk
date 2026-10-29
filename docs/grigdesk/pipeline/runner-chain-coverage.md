# Покрытие исполнителей проверяется по цепочке узла

Недоступность произвольного CLI профиля не останавливает все его прогоны. Runtime
проверяет только явно объявленные цепочки нужных agent-узлов. `routing_resolve` сохраняет
приоритет `RUNNER_OVERRIDE_STAGE_<STAGE>` → `RUNNER_OVERRIDE_PRIMARY` → `STAGE_<STAGE>*`
→ `PROJECT_RUNNER*`. Узлы command и gate исполнителя модели не требуют.

`start` проверяет все agent-узлы выбранного бандла и нужную bootstrap-разведку. Проверенный
catalog hash передаётся в CAS создания попытки: поздняя смена current не меняет охват.
`resume` читает закреплённый бандл и trusted cursor, обходит достижимые `next`/`rewind`
включая ветки `onFailure`; завершённая разведка исключается. Оверрайд SHIP после ворот
поэтому разрешает продолжение без исполнителей уже завершённых и недостижимых узлов.
При resume task-primary берётся из той же trusted launch identity, которую runtime
восстанавливает в реестр перед исполнением. Preflight строит эту будущую проекцию только
для чтения, сохраняя актуальные task-stage overrides; реестр до допуска не изменяется.

Снимки `<state>/coverage/<profile>/{structural,host}.env` используют `SCHEMA=2`:

| Поле | structural.env | host.env |
|---|---|---|
| `PROVIDERS` | Полный список провайдеров конфига через запятую | Тот же список |
| `PROVIDER_<id>` | `native`, `adapted`, `degraded`, `unavailable` | `ready`, `unavailable` |
| `CATALOG_REVISION` | Revision runner-конфига | Та же revision |
| `HASH` / `STRUCTURAL_HASH` | Отпечаток структуры | Связь с той же структурой |
| `RUNTIME_VERSION_<id>` | — | Сборка runtime-sensitive исполнителя |
| `FETCHED_AT` / `EXPIRES_AT` | — | Время полной проверки и срок |

Счётчики `UNAVAILABLE` и список `UNAVAILABLE_RUNNERS` остаются диагностикой всего профиля.
Профильный писатель один: `profile_runner_host_preflight` всегда пробует всех провайдеров
конфига без model call. Его код 1 означает записанную недоступность; runtime затем проверяет
свою область. Ошибки самого опроса или хранения не превращаются в успешный допуск.
`SCHEMA=1` не читается как разрешение: проверка узла один раз переписывает снимок полным
preflight. Неуспешная перепись сохраняет отказ. Совместимых полей или флага миграции нет.

В цепочке достаточно готового primary. Если он недоступен, диспетчер пропускает его
с причиной `unavailable_preflight` и запускает первый готовый failover. Причина видна
в журнале этапа и `RUNNER_REASON_<STAGE>`. Если готовых нет, узел возвращает 79,
`coverage_unavailable`, `STALLED_HUMAN=1` до model call. Свежесть, revision и связь слоёв
остаются обязательными; сборки сверяются только для готовых провайдеров цепочки узла.

Типизированный отказ start/resume сохраняет форму
`FACTORY_ERROR=runner_preflight_unavailable RUNNERS=<id,…>`. Список содержит недоступных
кандидатов блокирующих цепочек и может быть уже полного `UNAVAILABLE_RUNNERS` снимка.
Сервер передаёт его без дополнения исполнителями профиля. `gate --commit-only` остаётся
записью решения человека без preflight.

`coverage_catalog_promote` проверяет всех провайдеров снимка: достаточность одной цепочки
для runtime не разрешает публикацию неполного каталога. Регрессии —
`tests/engine/integration/route-coverage-refresh.sh`, `integration/catalog-promotion.sh`
и `contract/factory-launcher.sh`; серверный контракт — `factory-launch-runner.test.js`
и `factory-resume-confirm.test.js` через общий сторож памяти.
