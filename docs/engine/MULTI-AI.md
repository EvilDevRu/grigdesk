# Multi-AI в Factory: контракт и статус внедрения

Текущий статус:

- runtime-cutover и protocol v2 реализованы;
- проектные профили изолированы в локальных `profiles/<name>/`, целиком исключённых из Git;
  engine/server/CLI используют единый `FACTORY_PROFILES_DIR`, плоской legacy-раскладки больше нет;
- полный offline suite запускается без GrigDesk и без model call;
- live state мигрирован с backup в `~/.factory/state/migrations/`;
- metadata-only host preflight проверен на локальных профилях с разными runner chain и
  workspace mode;
- текущая поставка проверяется без перезапуска GrigDesk и без вызова реальных моделей;
- GrigDesk API и UI поднимают canonical runner chain, task/stage override, model family/effort,
  actual provider/model/effort, причину failover и историю attempt; активный run можно
  безопасно переключить на разрешённый резерв;
- всплывашка исполнителя показывает структурированное состояние лимитов: Claude — через
  OAuth usage, Codex — через read-only `account/rateLimits/read` официального app-server;
  актуальные или последние успешные бары, необходимость входа, отказ аккаунта, rate limit
  либо отсутствие usage API; для истёкшей CLI-сессии доступна команда повторного входа;
  account resources и действия провайдера имеют единый контракт без vendor-веток в UI:
  у Claude это Extra usage и потолок, у Codex — баланс ChatGPT credits, ссылка управления
  и расход заработанного reset credit при наличии;
- модельный селектор Codex строится по живому `model/list` его app-server, а не по
  захардкоженному seed; rollout, эффорты, default/hidden и рекомендуемые замены обновляются
  без релиза GrigDesk, дублирующие алиасы схлопываются;
- незакрытые конвейеры после перезапуска GrigDesk возобновляются его собственным механизмом
  восстановления; human gates и semantic stop не пересекаются, после трёх аварий нужен человек;
- редактор project/task policy, coverage каждого provider-а и breaker/cooldown в UI остаются
  отдельным этапом; engine CLI и debug-настройки уже доступны.
- B24 и медиа работают только через код/runtime GrigDesk; внешний checkout не является
  зависимостью, а regression-тест проверяет исходники, документацию и локальный `.env`.

## Зачем это нужно

Проекты выбирают исполнителя независимо. Например:

- один локальный профиль может идти Claude → Codex;
- другой локальный профиль может идти Codex → Claude;
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
engine/bin/factory profile <PROFILE_A> runner set claude --failover codex
engine/bin/factory profile <PROFILE_B> runner set codex --failover claude

# Политика отдельного этапа
engine/bin/factory profile <PROFILE> runner set REVIEW codex --failover claude

# Временная политика задачи
engine/bin/factory <TASK> runner set codex --failover claude
engine/bin/factory <TASK> runner set REVIEW claude --failover codex

# Переключить только активный run
engine/bin/factory <TASK> runner switch codex

# Посмотреть разрешённую цепочку
engine/bin/factory profile <PROFILE> runner show
engine/bin/factory <TASK> runner show
```

## Интерфейс GrigDesk

Граф читает ту же политику `profiles/<name>/runners.env`, task override и runtime telemetry,
что и движок. Второй реестр совместимости или список версий моделей на фронте не заводится.

### Схема проекта

В заголовке схемы:

- цепочка проекта, например `Claude → Codex`;
- либо глобальный override задачи, если он установлен.

На узле этапа:

- свой override, если он есть;
- семейство модели и effective effort из `runners.env`, а не policy из route schema;
- фактический provider/model/effort последней попытки;
- значок автоматического переключения;
- блокирующая причина, если продолжать нельзя.

`runKey` исполняемых узлов закреплённого route bundle связывает внутренние визуальные фазы
с реальным runner-stage; API проецирует их в карту `runnerKeys` (для legacy её источником
остаётся `graph.json.runner_keys`).
Например, несколько узлов планирования могут показывать одну попытку `PLAN`, не выдумывая
несуществующие запуски `PLANS`/`SKEPTIC`.

### Карточка агента

Карточка активной попытки показывает:

- `primary`, текущего исполнителя и следующий допустимый failover;
- модель и effort рядом, например `gpt-5.6-sol · effort ultra`;
- номер попытки;
- причину предыдущего переключения;
- команду «переключить этот run» на другого кандидата разрешённой цепочки.

Launcher пишет `MODEL` и `EFFORT` каждого реального запуска в его `meta.env`; GrigDesk отдаёт
оба поля в `runner.attempts[]`. В верхней карточке уже запускавшегося provider-а фактический
effort последней попытки имеет приоритет над текущей policy: изменение `runners.env` не должно
переписывать историю завершённого этапа. До первого запуска или для старой telemetry без
`EFFORT` интерфейс показывает effective policy из `runner.models[provider].effort`.

`POST /api/tasks/:id/runner/switch` доступен только при активной попытке, сверяет target
с canonical chain и делегирует изменение `engine/bin/factory <task> runner switch`.
CAS по `run/epoch` и точную process group проверяет engine; GrigDesk не пишет control state.

При автоматическом переключении одна карточка этапа не заменяется новой задачей: внутри неё
добавляется попытка, например:

```text
BUILD
1. Claude / opus-family / effort max — limit_exhausted
2. Codex / gpt-5.6-sol / effort ultra — running
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
engine/bin/factory profile <PROFILE> model set DEFAULT claude \
  family=opus version=latest effort=max
engine/bin/factory profile <PROFILE> model set DEFAULT codex \
  family=sol version=latest effort=xhigh
engine/bin/factory profile <PROFILE> model set LINT claude \
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
- не создаёт implicit primary: его всегда явно задаёт человек через canonical
  `runners.env` или CLI.

## Coverage и preflight

Перед рабочим запуском:

```bash
RUN_HOST_PREFLIGHT=1 engine/bin/factory-check --host-preflight
```

Preflight не отправляет prompt и не делает model call. Он проверяет локальные CLI, auth
metadata, каталоги моделей и capabilities, после чего пишет coverage artifacts на 6 часов
по умолчанию (`FACTORY_HOST_PREFLIGHT_TTL`, максимум сутки).

При `RUNNERS_COVERAGE=required` запуск запрещён, если:

- artifact отсутствует или остаётся просроченным после повторного preflight;
- конфигурационная revision изменилась;
- обязательный кандидат unavailable;
- семейство/effort/capability этапа не поддерживается.

Перед очередным узлом корректный положительный снимок, истёкший по сроку, запускает
один metadata-only preflight. После него движок снова сверяет исходную revision и
текущее время. Тот же повтор запускает несовпадение сборки runtime-sensitive исполнителя
с `RUNTIME_VERSION_<id>` снимка. Остальные отказы не запускают обновление; неуспешная
перепроверка сохраняет `coverage_unavailable` до model call. Подробнее —
[проверка внутри длинного маршрута](../grigdesk/pipeline/coverage-expiry-during-route.md).

## Классификация ошибок

Dispatcher принимает нормализованный результат adapter-а.

У Codex распознавание ошибок не зависит от номера CLI: классифицируются только
подтверждённые терминальные JSON-события. Отказ `Selected model is at capacity`
имеет класс `transient`, без переключения модели или breaker квоты. Пояснение
передаётся человеку отдельно от класса, поэтому даже `unknown` сохраняет текст
ошибки. Формат — [диагностика отказов](../grigdesk/pipeline/runner-failure-diagnostics.md).

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

## Предохранитель (breaker)

Доказанный `limited` записывается предохранителем в `<state>/runners/breakers/v1/<provider>/
<fingerprint>/`, чтобы следующие этапы не тратили минуты на заведомо закрытую дверь. Считается
он отдельно для пары provider + auth profile и не переносит аварию Claude одного проекта
на Codex другого. Область берётся у классификатора: `provider` закрывает исполнителя целиком,
`family` — одно семейство (штатный family fallback уводит на запасное семейство того же
исполнителя), `model` — одну модель. При проверке приоритет `provider` → `family` → `model`.

**Предохранитель никогда не бывает бессрочным.** Срок сброса называет сам провайдер —
опциональный метод контракта `limit_until` (см. [ADDING-RUNNER.md](ADDING-RUNNER.md));
раннер его не объявил или ответить не смог — держим cooldown от момента обнаружения
(`FACTORY_BREAKER_COOLDOWN_S`, по умолчанию 900 с). Пустое `LIMITED_UNTIL` означало «навсегда»:
исполнитель выпадал из цепочки до ручного удаления файла, а лимит подписки к тому времени давно
кончался.

Срок приходит из чужого текста, поэтому он ограничивается в единственном месте записи
(`breaker_record`), а не в каждом раннере:

- потолок — сутки от обнаружения (`FACTORY_BREAKER_MAX_S`). Промах разбора даты на год выключил
  бы живой ИИ насовсем, а чинится такое только удалением файла руками;
- срок в прошлом отбрасывается — это тот же промах разбора, а не «лимит уже кончился»: отказ
  провайдера случился только что. Остаётся cooldown.

**Явный выбор человека сильнее предохранителя.** Предохранитель — ДОГАДКА по прошлому отказу:
он лишь предполагает, что провайдер всё ещё в лимите. Названный человеком исполнитель — факт,
и `dispatcher_run_chain` заходит в него, даже когда предохранитель закрыт (восьмой аргумент
`human_choice`). Явным считается назначение на задачу или этап (`routing_resolve` вернул
`SOURCE=task` либо `task-stage`, то есть `RUNNER_OVERRIDE_*` в реестре задачи) и нажатая
кнопка переключения живого run (`manual_switch`). Молчаливая подмена выглядела как сломанная
кнопка: человек переключал этап на Claude, а тот уезжал в резерв без единого слова.

Обход **именной**: он покрывает ровно названного исполнителя. Резерв цепочки остаётся под
предохранителем, поэтому холостой заход делает один кандидат, а не вся цепочка; если названный
исполнитель и правда в лимите, этап штатно встаёт на человека. Цена решения — один короткий
заход в отказ вместо отменённого выбора. Автоматическая маршрутизация предохранитель уважает
как раньше.

## Восстановление после перезапуска

**Его нет.** Погибший демон никто не поднимает: `resume` — явное действие человека по
кнопке и только для exact attempt. Тумблер `autoRecoverPipelines`, эндпоинт
`GET /api/factory/recovery` и чистый решатель `lib/pipeline-recovery.js` удалены: ни один
из них не был подключён к runtime, а решатель вдобавок судил по `WF_STATUS` и полям
`RECOVERY_*` provider-writable реестра — то есть по проекции, которую сам движок
терминальным маркером не считает.

Раньше здесь было описано работающее автовосстановление; фактически оно не выполнялось
уже на момент, когда текст читали. Это и есть цена расхождения документа с кодом:
дежурный видел «прогон поднимется сам» и не поднимал его руками.

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
engine/bin/factory profile <PROFILE> debug set verbose --for 2h
engine/bin/factory <TASK> debug set verbose --for 30m
engine/bin/factory <TASK> debug clear
```

Task debug имеет TTL по умолчанию. Логи типизированы и не содержат prompt, credentials,
capability token или полный ответ модели. Глобальная настройка уже доступна в
«Настройки → Запуски»; индикация profile/task scope на схеме относится к целевому UI выше.

## Историческое состояние

После cutover старые registry остаются только данными для чтения/ручного архива.
Единый `engine/bin/factory` не имеет legacy orchestration, migration launcher или resume
по одному `RUN_PROTOCOL`; продолжение требует exact immutable route attempt.

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
9. отдельный контролируемый рабочий запуск позднее.

GrigDesk и реальные модели на шагах 1–8 не запускаются. Эти шаги выполнены; рабочий запуск
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
  route-dispatch.sh
  core-multi-runner.sh
  runtime-switch.sh
  coverage-gate.sh

tests/server/
  codex-catalog.test.js
  runner-state.test.js
  runner-control.test.js
  factory-graph-runner-keys.test.js
  provider-usage.test.js
  codex-abort.test.js
  codex-resume-args.test.js
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
- все тесты зелёные без запуска GrigDesk и без model call.

Runtime-критерии этого раздела проверяются offline suite. Multi-AI UI и восстановление
проверяются unit-тестами и production-сборкой; текущая версия не перезапускает GrigDesk и
не выполняет рабочий запуск.
