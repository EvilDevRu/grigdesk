# Устройство Factory Engine

Документ для изменений в `engine/`. Контракт проекта описан в
[PROFILE-CONTRACT.md](PROFILE-CONTRACT.md), создание нового профиля — в
[NEW-PROJECT.md](NEW-PROJECT.md), multi-AI cutover — в [CODEX.md](CODEX.md).

## Инварианты

1. Движок не содержит имён контейнеров, БД, репозиториев и команд конкретного проекта.
2. Каждый локально установленный профиль имеет валидный `profiles/<name>/runners.env`;
   `/profiles/` не отслеживается Git, implicit provider отсутствует.
3. Агент не пишет pipeline напрямую. Terminal result идёт через run-scoped `stage-result`,
   разрешённый progress — через `stage-progress`.
4. Любой повтор/switch получает новый `run_id`, больший `epoch` и новую capability.
5. Автоматический failover выполняется только для классифицированных provider failures.
6. Config/state writers используют `flock`, CAS/revision и atomic rename.
7. Offline tests не запускают Cockpit и не выполняют model call.

## Карта

| Путь | Ответственность |
|---|---|
| `bin/factory` | CLI, start/resume/demo, обязательные config/protocol gates |
| `bin/factory-check` | profile contract и metadata-only host preflight |
| `bin/factory-new` | полный скелет `profiles/<name>/` |
| `bin/factory-migrate-v2` | backup и разовая миграция task state |
| `lib/core.sh` | stage loop, gates, retries, readonly guard |
| `lib/routing.sh` | precedence task-stage → task → profile-stage → profile-project |
| `lib/multi-runner.sh` | model policy, dispatcher, telemetry |
| `lib/dispatcher.sh` | классификация попыток/failover/breaker |
| `lib/executor.sh`, `lib/runner-launcher.sh` | запуск adapter-а и run capability |
| `lib/runners/*.sh` | provider adapters/catalog/probe |
| `lib/profile-config.sh` | schema, validation, revision CAS, atomic writer |
| `lib/coverage.sh`, `lib/profile-preflight.sh` | readiness/capability artifacts |
| `lib/pipeline-store.sh` | locked/atomic pipeline storage |
| `lib/run-state.sh` | active run identity и result/progress CAS |
| `lib/stage-result.sh` | agent terminal API |
| `lib/stage-progress.sh` | allowlisted nonterminal API |
| `lib/pipeline-control.sh` | privileged control update |
| `lib/pipeline-set.sh` | process-level pipeline writer |
| `lib/debug-settings.sh`, `lib/debug-log.sh` | scoped debug config и redacted trace |
| `profiles/<name>/profile.sh` | project-specific hooks/prompts |
| `profiles/<name>/runners.env` | canonical runner/model policy |
| `profiles/<name>/graph.json` | UI graph |
| `tests/engine/` | unit/contract/integration/profile checks |

## Запуск этапа

```text
factory
  → validate profile + canonical runner config
  → require RUN_PROTOCOL=2
  → resolve route chain
  → resolve family policy against local catalog
  → require fresh coverage
  → begin run_id/epoch/capability
  → launch provider adapter
  → classify outcome
      success/status result → commit
      switchable provider failure → next candidate
      task/policy/unknown-side-effect failure → stop
```

`core.sh` provider-agnostic: в нём нет прямого запуска Claude/Codex и нет выбора модели.
Project write roots и `STATE_DIR` передаются обоим adapter-ам явно; Codex получает их через
повторяемый `--add-dir`, сохраняя `workspace-write`, а не переходя в `danger-full-access`.

## Canonical config

Parser принимает только allowlisted keys и безопасные значения. Обязательны:

```text
RUNNERS_SCHEMA=1
CONFIG_REVISION=<integer>
PROJECT_RUNNER_PRIMARY=<provider>
```

`profile_config_write`:

1. берёт lock;
2. проверяет schema и expected revision;
3. строит новый документ;
4. пишет temp в том же каталоге;
5. делает atomic rename.

Код 72 означает stale revision, 78 — неподдерживаемую schema/config.

Routing не имеет запасного provider-а вне canonical policy.

## Model policy

Приоритет модели:

```text
stage/provider policy → DEFAULT/provider policy → provider default family
```

Поля:

```text
FAMILY
FAMILY_FAILOVER
VERSION
VARIANT
EFFORT
EXACT
```

`family + version=latest` разрешается только по локальному trusted catalog. Codex adapter
читает `models_cache.json`; сеть на пути разрешения модели не нужна.

Exact id допустим, если он подтверждён каталогом/coverage. Молчаливого downgrade нет.

## Ошибки и failover

Adapter возвращает нормализованную категорию, а не текст, который core пытается угадать.

Switchable:

- `unavailable_preflight`/`route_unavailable` до model call;
- доказанный `limited` после начала model call;
- `provider_unavailable` для 401/403, если event stream доказывает отсутствие model/tool activity;
- CAS-подтверждённый manual switch.

Non-switchable:

- task/stage result `failed`;
- test/build/sandbox failure;
- permission/safety/policy denied;
- malformed/stale status;
- operator cancellation;
- `context_overflow`/HTTP 413;
- обычный HTTP 429 без доказанного subscription/weekly limit;
- outcome unknown после возможного side effect;
- auth/transport error после фактической активности модели.

Breaker scoped по provider/auth profile. Он не является глобальным переключателем всей фабрики.

## Status protocol

`run_state_begin` атомарно:

- увеличивает epoch;
- создаёт active run record;
- сохраняет hash capability;
- выставляет stage `running`.

Capability передаётся adapter-у через FD, а не argv/env/prompt.

`stage-result` проверяет:

- активный task/stage;
- точный `run_id`;
- точный `epoch`;
- capability hash;
- состояние `active`.

Повторный или поздний terminal result возвращает конфликт и не меняет новый run.

`stage-progress` выполняет те же проверки и дополнительно применяет allowlist ключей/значений.
Он никогда не завершает текущий stage.

`pipeline-set.sh` не входит в agent permissions. Terminal значения protocol v2 через него
отклоняются как дополнительный защитный слой.

## Pipeline storage

Canonical task file:

```text
${STATE_DIR}/t<TASK>.pipeline
```

Архив:

```text
${STATE_DIR}/archive/t<TASK>.pipeline
```

Все multi-key updates выполняются под task lock. Readers должны читать последний canonical
key; writers не должны использовать ad-hoc `sed` вне storage API.

## Coverage gate

`factory-check --host-preflight` проверяет CLI/catalog/capabilities без prompt и model call.
Artifacts привязаны к config revision и по умолчанию действуют 6 часов
(`FACTORY_HOST_PREFLIGHT_TTL`, не более суток). Этого хватает на рабочую сессию и длинный
этап, но проверка всё равно регулярно подтверждает состояние CLI/auth/catalog.

`RUNNERS_COVERAGE=required` означает fail-closed:

- нет artifact;
- artifact истёк;
- revision не совпадает;
- provider/model/capability unavailable.

Ни одно из этих состояний не лечится скрытым выбором другого provider-а.

## Debug

Эффективный уровень:

```text
task → profile → global → off
```

Task-level debug ограничивается TTL. Typed events пишут routing/classification/breaker/status
решения, но не prompt, credentials, capability и полный model response.

Debug setting хранится отдельно от runner config, поэтому его включение не инвалидирует
policy revision/coverage.

## Миграция состояния

Перед миграцией:

```bash
engine/bin/factory-migrate-v2 --dry-run
```

Рабочий запуск:

```bash
engine/bin/factory-migrate-v2
```

Мигратор:

- прекращает работу до записи, если найден живой orchestrator;
- валидирует profile config всех изменяемых задач;
- копирует исходные pipeline в timestamped backup;
- атомарно добавляет `RUN_PROTOCOL=2`;
- переносит fixed markers и malformed pipeline files в backup;
- пишет `manifest.tsv`;
- повторно запускается без изменений.

## Как проверять изменения

Сначала targeted test, затем полный suite:

```bash
rg -l -0 '^#!/usr/bin/env bash' engine/bin engine/lib profiles | xargs -0 bash -n
python3 -m py_compile engine/lib/dashboard.py engine/bin/factory-graph-new
engine/bin/factory-check --quick
tests/run-all.sh
```

Тесты располагаются только в корневом `tests/`, документация — только в корневом `docs/`.
Новые `engine/tests` и `engine/docs` не создавать.

Host preflight запускается отдельно и явно:

```bash
RUN_HOST_PREFLIGHT=1 engine/bin/factory-check --host-preflight
```

Он допускается после offline suite, но до Cockpit/canary. Реальный model call не является
частью автоматического test suite.

## Когда изменение вступает в силу

- `profile.sh` перечитывается перед этапом;
- `runners.env` читается при каждом routing decision;
- task override читается из pipeline;
- server/web код требует обычного рестарта соответствующего процесса;
- уже запущенная provider attempt не меняет модель посередине; switch создаёт новую attempt.
