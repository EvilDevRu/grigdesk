# Несколько ИИ в Factory: контракт и статус внедрения

Статус на 2026-07-29:

- runtime-cutover и protocol v2 реализованы;
- проектные профили изолированы в локальных `profiles/<name>/`, целиком исключённых из Git;
  engine/server/CLI используют единый `FACTORY_PROFILES_DIR`, плоской legacy-раскладки больше нет;
- полный offline suite запускается без Cockpit и без model call;
- live state мигрирован с backup в `~/.factory/state/migrations/`;
- metadata-only host preflight прошёл для `arsenkin`, `cockpit` и `rdesigner`;
- текущая поставка проверяется без перезапуска Cockpit и без вызова реальных моделей;
- Cockpit API и UI поднимают canonical runner chain, task/stage override, model family,
  actual provider/model, причину failover и историю attempt; активный run можно безопасно
  переключить на разрешённый резерв;
- всплывашка исполнителя показывает структурированное состояние лимитов: Claude — через
  OAuth usage, Codex — через read-only `account/rateLimits/read` официального app-server;
  актуальные или последние успешные бары, необходимость входа, отказ аккаунта, rate limit
  либо отсутствие usage API; для истёкшей CLI-сессии доступна команда повторного входа;
- незакрытые конвейеры после перезапуска Cockpit возобновляются его собственным механизмом
  восстановления; human gates и semantic stop не пересекаются, после трёх аварий нужен человек;
- редактор project/task policy, coverage каждого provider-а и breaker/cooldown в UI остаются
  отдельным этапом; engine CLI и debug-настройки уже доступны.
- B24 и медиа работают только через код/runtime Cockpit; внешний checkout не является
  зависимостью, а regression-тест проверяет исходники, документацию и локальный `.env`.

## Зачем это нужно

Проекты выбирают исполнителя независимо:

- `arsenkin` может идти Claude → Codex;
- `rdesigner` может идти Codex → Claude;
- отдельный этап или задача может принудительно выбрать другую цепочку;
- исчерпание лимита или временная недоступность primary не должны останавливать конвейер,
  если следующий исполнитель совместим и готов;
- ошибка самой задачи, инструментов проекта или политики безопасности не должна маскироваться
  переключением ИИ.

Глобального «текущего ИИ» нет. Routing вычисляется для каждой попытки этапа.

## Пользовательская модель

У проекта есть обязательная политика:

```text
project primary → project failover chain
```

У этапа может быть своя политика, а у конкретной задачи — временный override:

```text
task-stage → task → profile-stage → profile-project
```

Если ни один кандидат не может продолжить, карточка задачи остаётся на текущем этапе и
показывает причину блока. Уже выполненные этапы не повторяются.

Команды оператора:

```bash
# Постоянная политика проекта
engine/bin/factory profile arsenkin runner set claude --failover codex
engine/bin/factory profile rdesigner runner set codex --failover claude

# Политика отдельного этапа
engine/bin/factory profile arsenkin runner set REVIEW codex --failover claude

# Временная политика задачи
engine/bin/factory 7379 runner set codex --failover claude
engine/bin/factory 7379 runner set REVIEW claude --failover codex

# Переключить только активный run
engine/bin/factory 7379 runner switch codex

# Посмотреть разрешённую цепочку
engine/bin/factory profile arsenkin runner show
engine/bin/factory 7379 runner show
```

## Интерфейс Cockpit

Граф читает ту же политику `profiles/<name>/runners.env`, task override и runtime telemetry,
что и движок. Второй реестр совместимости или список версий моделей на фронте не заводится.

### Схема проекта

В заголовке схемы:

- цепочка проекта, например `Claude → Codex`;
- либо глобальный override задачи, если он установлен.

На узле этапа:

- свой override, если он есть;
- семейство модели, а не зафиксированный маркетинговый номер;
- фактический provider/model последней попытки;
- значок автоматического переключения;
- блокирующая причина, если продолжать нельзя.

`graph.json.runner_keys` связывает внутренние визуальные фазы с реальным runner-stage.
Например, несколько узлов планирования могут показывать одну попытку `PLAN`, не выдумывая
несуществующие запуски `PLANS`/`SKEPTIC`.

### Карточка агента

Карточка активной попытки показывает:

- `primary`, текущего исполнителя и следующий допустимый failover;
- фактическую модель;
- номер попытки;
- причину предыдущего переключения;
- команду «переключить этот run» на другого кандидата разрешённой цепочки.

`POST /api/tasks/:id/runner/switch` доступен только при активной попытке, сверяет target
с canonical chain и делегирует изменение `engine/bin/factory <task> runner switch`.
CAS по `run/epoch` и точную process group проверяет engine; Cockpit не пишет control state.

При автоматическом переключении одна карточка этапа не заменяется новой задачей: внутри неё
добавляется попытка, например:

```text
BUILD
1. Claude / opus-family — limit_exhausted
2. Codex / sol-family — running
```

### Блокирующие состояния

Интерфейс различает:

- `limited` после начавшегося model call — можно перейти к следующему совместимому provider-у;
- `provider_unavailable` для доказанного 401/403 без единого ответа модели или tool call —
  можно перейти к следующему provider-у без установки breaker;
- `unavailable_preflight`, `route_unavailable` до model call — можно пропустить кандидата;
- `context_overflow` (в том числе HTTP 413), обычный `rate_limit` и ошибка после фактической
  активности модели — переключение запрещено: исход попытки может быть неоднозначным;
- `task_error`, `tests_failed`, `policy_denied`, `unsafe_action`, `bad_prompt`,
  `status_protocol_error` — переключение запрещено, потому что другой ИИ не исправляет причину;
- `chain_exhausted` — все разрешённые кандидаты исчерпаны;
- `coverage_unavailable` — конфигурация или preflight не позволяют безопасно начать model call.

Кнопка принудительного переключения не обходит policy/security/status ошибки. Она только
выбирает другого кандидата для новой попытки.

Пока не выведены в UI: coverage по каждому provider-у, breaker/cooldown и формы постоянного
изменения project/task policy. Для них остаются `factory ... runner` и host-preflight CLI.

## Семейства моделей

Политика хранит стабильное семейство:

```text
Claude: opus / sonnet / haiku
Codex:  sol / terra
```

`version=latest` означает последнюю локально известную модель внутри указанного семейства.
Поэтому выход Opus 6 или следующего `gpt-*-sol` не требует правки профиля.

Для Claude это список безопасных CLI-алиасов текущего adapter-а. У Fable нет стабильного
алиаса в Claude CLI, поэтому движок не должен угадывать `family=fable`: такое семейство
можно включать только после появления доверенного локального catalog snapshot/adapter support.

Пример:

```bash
engine/bin/factory profile arsenkin model set DEFAULT claude \
  family=opus version=latest effort=max
engine/bin/factory profile arsenkin model set DEFAULT codex \
  family=sol version=latest effort=xhigh
engine/bin/factory profile arsenkin model set LINT claude \
  family=haiku version=latest effort=medium
```

Каталог Codex читается из локального `models_cache.json`; сетевой discovery на критическом
пути не выполняется. Неизвестный exact model id не угадывается. Для provider-а без безопасного
локального alias нужен подтверждённый catalog snapshot.

Совместимость считается по capabilities provider-а и конкретного этапа, а не по названию
модели. Обновление модели не меняет контракт этапа, пока metadata-only preflight подтверждает
требуемые возможности.

## Каноническая конфигурация

Для каждого `profiles/<name>/profile.sh` обязателен `profiles/<name>/runners.env`:

```text
RUNNERS_SCHEMA=1
CONFIG_REVISION=1
RUNNERS_COVERAGE=required
PROJECT_RUNNER_PRIMARY=claude
PROJECT_RUNNER_FAILOVER=codex
MODEL_DEFAULT_CLAUDE_FAMILY=opus
MODEL_DEFAULT_CLAUDE_VERSION=latest
MODEL_DEFAULT_CODEX_FAMILY=sol
MODEL_DEFAULT_CODEX_VERSION=latest
```

Runtime не читает model/runner hooks из `.sh`. Отсутствующий или невалидный canonical-файл
останавливает запуск до model call с кодом 78.

Запись конфигурации:

- проверяет schema и допустимые ключи;
- использует `CONFIG_REVISION` как CAS;
- сериализуется через `flock`;
- сохраняется во временный файл и атомарно переименовывается;
- не создаёт implicit primary: его всегда задаёт человек или `factory-new`.

## Coverage и preflight

Перед рабочим запуском:

```bash
RUN_HOST_PREFLIGHT=1 engine/bin/factory-check --host-preflight
```

Preflight не отправляет prompt и не делает model call. Он проверяет локальные CLI, auth
metadata, каталоги моделей и capabilities, после чего пишет короткоживущие coverage artifacts.

При `RUNNERS_COVERAGE=required` запуск запрещён, если:

- artifact отсутствует или просрочен;
- конфигурационная revision изменилась;
- обязательный кандидат unavailable;
- семейство/effort/capability этапа не поддерживается.

## Классификация ошибок

Dispatcher принимает нормализованный результат adapter-а.

Переключение разрешено:

- до model call: `unavailable_preflight` и `route_unavailable`;
- после начала model call: только доказанный `limited`;
- при 401/403: строгий `provider_unavailable`, только если event stream доказывает отсутствие
  ответа модели и запуска инструментов;
- вручную: только CAS-подтверждённый `manual_switch`.

Переключение запрещено:

- агент завершил этап как `failed`;
- тесты, линтер, сборка или sandbox упали;
- отказ разрешений или safety policy;
- malformed stage result;
- stale run/capability;
- неясно, был ли уже выполнен необратимый side effect;
- operator отменил run;
- `context_overflow`/HTTP 413: это слишком большой запрос, а не блокировка аккаунта;
- обычный HTTP 429 без доказанного subscription/weekly limit;
- late auth/transport failure после реальной активности модели.

Для сомнительных транспортных сбоев adapter возвращает `outcome_unknown`; автоматический
повтор другим ИИ запрещён, пока операция не доказана идемпотентной.

Breaker считается отдельно для provider/auth profile. Он не переносит аварию Claude одного
проекта на Codex другого проекта.

## Восстановление после перезапуска

При запуске Cockpit один раз проверяет все `WF_STATUS=running`. Если демон задачи мёртв,
локальный профиль полон (`profile.sh`, `runners.env`, `graph.json`) и задача не ждёт человека,
Cockpit запускает `factory <task> resume` в отдельном systemd scope. Уже выполненные этапы
остаются в реестре.

Автоматика не возобновляет:

- живой, завершённый или явно остановленный прогон;
- любое `GATE_*=waiting`;
- `STALLED_HUMAN=1`;
- задачу без локального профиля;
- четвёртую аварию в пределах 15 минут.

Решения видны в `GET /api/factory/recovery` и в полях `RECOVERY_*` реестра. Тумблер
`Настройки → Запуски → Продолжать незакрытые конвейеры` пишет
`prefs.autoRecoverPipelines`; старого отдельного watchdog/флага в tmpfs больше нет.

## Протокол этапа

Каждая попытка получает:

- `run_id`;
- монотонный `epoch`;
- capability token через унаследованный file descriptor.

Агенту доступны только:

```text
stage-result   — terminal done/skipped/failed текущего run
stage-progress — ограниченные маршрутные и внутренние узлы
```

Terminal result применяется compare-and-set по `task + stage + run_id + epoch + token`.
Поздний ответ предыдущего provider-а не может завершить новую попытку.

`stage-progress` допускает только schema-валидные ключи:

- `ROUTE`, `ROUTE_BY`, `SIZE`, `TRIVIAL_ESCALATED`;
- `PLANS`, `SKEPTIC`, `VALIDATE`, `TRANSLATOR`.

Он не может менять terminal status этапа, runner overrides, debug, protocol, gates,
оркестратор и control metadata.

## Диагностический режим

Уровни:

```text
off → errors → decisions → verbose
```

Scopes и приоритет:

```text
task → profile → global → off
```

Команды:

```bash
engine/bin/factory settings debug set decisions
engine/bin/factory profile arsenkin debug set verbose --for 2h
engine/bin/factory 7379 debug set verbose --for 30m
engine/bin/factory 7379 debug clear
```

Task debug имеет TTL по умолчанию. Логи типизированы и не содержат prompt, credentials,
capability token или полный ответ модели. Глобальная настройка уже доступна в
«Настройки → Запуски»; индикация profile/task scope на схеме относится к целевому UI выше.

## Миграция состояния

Разовый переход:

```bash
engine/bin/factory-migrate-v2 --dry-run
engine/bin/factory-migrate-v2
```

Мигратор до любой записи:

- проверяет canonical config профиля каждой задачи;
- отказывается работать при живом оркестраторе;
- находит активные и архивные canonical pipeline;
- создаёт backup с manifest;
- атомарно добавляет `RUN_PROTOCOL=2`;
- переносит старые fixed markers и ошибочные pipeline-файлы в backup, не удаляя их.

Повторный запуск идемпотентен. Восстановление выполняется вручную из пути, указанного в
`manifest.tsv`.

## TDD и порядок поставки

Порядок обязателен:

1. тест на новый инвариант;
2. подтверждённый RED;
3. минимальная реализация;
4. ревью границ и отказов;
5. unit/contract/integration;
6. полный offline suite;
7. миграция состояния с backup;
8. metadata-only host preflight;
9. отдельный контролируемый рабочий canary позднее.

Cockpit и реальные модели на шагах 1–8 не запускаются. Эти шаги выполнены; рабочий canary
остаётся отдельной операцией после явного разрешения.

Основные наборы:

```text
tests/engine/unit/
  cutover.sh
  routing.sh
  model-policy*.sh
  codex-local-catalog.sh
  run-status.sh
  stage-progress.sh

tests/engine/contract/
  canonical-profiles.sh
  runner-cli.sh
  profile-config.sh

tests/engine/integration/
  protocol-v2-migration.sh
  core-multi-runner.sh
  runtime-switch.sh
  coverage-gate.sh

tests/server/
  runner-state.test.js
  runner-control.test.js
  factory-graph-runner-keys.test.js
  pipeline-recovery.test.js
  provider-usage.test.js
  codex-abort.test.js
  b24-timer-boundary.test.js

tests/web/
  provider-usage.test.js
  runner-display.test.js
```

Запуск:

```bash
tests/run-all.sh
```

## Критерии готовности runtime

- ни один профиль не запускается без валидного `runners.env`;
- нет прямого Claude-only пути в `core.sh`;
- project/task/stage routing работает по заявленному precedence;
- family policy переживает появление новых model id;
- retry/failover разрешён только для классифицированных provider-сбоев; 401/403 failover
  требует доказанного отсутствия model/tool activity, 413 не переключает provider;
- stale result предыдущей попытки отвергается;
- агент не имеет доступа к общему pipeline writer;
- Codex получает нужные write roots через `--add-dir` без отключения sandbox;
- миграция создаёт backup и не оставляет fixed markers/ghost pipeline в live state;
- debug выключаем, ограничен TTL и не пишет секреты;
- все тесты зелёные без запуска Cockpit и без model call.

Runtime-критерии этого раздела проверяются offline suite. Multi-AI UI и восстановление
проверяются unit-тестами и production-сборкой; текущая версия не перезапускает Cockpit и
не выполняет рабочий canary.
