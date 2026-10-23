# Подключение нового проекта

Профиль проекта — локальная конфигурация окружения в profiles/<name>/. Движок не знает
названий проектов и не создаёт профиль по догадкам. Старые генераторы профиля удалены: они
создавали массивы этапов и shell-prompts, которые единый route-движок не исполняет.

## Что выяснить до настройки

С человеком нужно зафиксировать:

1. Какие Git-репозитории входят в работу и какой из них является основным cwd.
2. Режим workspace:
   - isolated — отдельные workspace создаёт project-specific lifecycle;
   - shared — source и workspace совпадают с primary checkout, стенд уже существует.
3. Как проверить health стенда и какие frontend/API порты публиковать.
4. Какие пути пишет само приложение: логи, кэши и тестовые артефакты.
5. Какие команды нужны агентам и какие команды должны быть запрещены.
6. Какие маршруты нужны. Обычно достаточно feature и debug; различие должно выражаться
   в гарантиях и topology, а не только в тексте prompt.
7. Есть ли delivery. Маршрут без узла ship не получает commit/push/PR actions.
8. Для shared-режима — какие checkout, стенд и GPU должны блокироваться одной durable lease.

## Структура

Значение каждого общего параметра, его формат, умолчание и место хранения перечислены
в [справочнике профилей](../grigdesk/pipeline/project-profiles.md).

Создай вручную:

~~~text
profiles/<name>/
  profile.sh
  runners.env
  graph.json
  dashboard.env
  routes/
    definition.mjs
    publish.mjs
    prompts/...
~~~

Содержимое профилей — локальная конфигурация вне Git исходников; ссылка на внешний каталог
может отслеживаться отдельно. Не добавляй проектные пути и секреты в tracked engine-файлы.

До публикации оставь capability выключенной:

~~~json
{
  "capabilities": []
}
~~~

Профиль без "route-v2" не запускается — это ожидаемый fail-closed этап настройки.

## runners.env

Минимальный canonical config:

~~~text
RUNNERS_SCHEMA=1
CONFIG_REVISION=1
RUNNERS_COVERAGE=required
PROJECT_RUNNER_PRIMARY=codex
PROJECT_RUNNER_FAILOVER=claude
~~~

Модели и stage overrides добавляются теми же ключами MODEL_*/STAGE_*, что описаны в
[PROFILE-CONTRACT.md](PROFILE-CONTRACT.md). После изменения нужен metadata-only host preflight.

## profile.sh

Обязательные route hooks:

~~~bash
profile_workspace_mode         # isolated | shared
profile_repositories TASK      # name<TAB>source<TAB>workspace
profile_project_context        # JSON: stack[] + guardrails[]
profile_source_branch TASK REPO # ветка указанного репозитория
profile_container TASK
profile_stand_alive TASK       # только health, без lifecycle
~~~

Isolated-профиль, чей стенд не переживает перезагрузку машины, объявляет ещё
`profile_stand_start TASK` — идемпотентный подъём процессов существующего стенда. GrigDesk
зовёт его перед продолжением попытки, если стенд не отвечает (см. PROFILE-CONTRACT.md).

Shared-профиль дополнительно реализует:

~~~bash
profile_service_ports TASK                 # FE_PORT<TAB>API_PORT
profile_exclusive_resources TASK           # exact workspace:/... и stand:...
profile_instrumentation_restored TASK SCOPE_FILE
~~~

Пример минимального shared-контракта:

~~~bash
PROFILE_NAME="example"
PROJECT_ROOT="/absolute/path/example"
PROFILE_SERVICE_HOST="127.0.0.1"

profile_workspace_mode() { printf 'shared\n'; }
profile_repositories() {
  printf 'example\t%s\t%s\n' "$PROJECT_ROOT" "$PROJECT_ROOT"
}
profile_project_context() {
  printf '%s\n' '{"stack":["TODO"],"guardrails":["TODO"]}'
}
profile_source_branch() { git -C "$PROJECT_ROOT" symbolic-ref --quiet --short HEAD; }
profile_container() { printf 'example\n'; }
profile_service_ports() { printf '8080\t8080\n'; }
profile_stand_alive() { curl -sf --max-time 3 http://127.0.0.1:8080/health >/dev/null; }
profile_exclusive_resources() {
  printf '%s\n' \
    "workspace:$PROJECT_ROOT" \
    'stand:example' \
    'gpu:primary'
}
# Если стенд читает checkout напрямую, отдельный sync не нужен, но health после
# восстановления exact scope всё равно обязателен.
profile_instrumentation_restored() { profile_stand_alive "$1"; }
~~~

Shared launcher не вызывает up.sh/down.sh, не создаёт worktree, контейнеры или volumes и
не запускает остановленный стенд. Lease должна жить до terminal результата или abandon, включая
все человеческие ворота. Cleanup инструментации обязан синхронизировать восстановленный scope во
внешний стенд через profile_instrumentation_restored; ошибка оставляет попытку остановленной и
lease занятой.

В isolated-режиме lifecycle допустим только для объектов exact attempt. Source и workspace
обязаны быть непересекающимися; общие checkout/стенды нельзя выдавать за isolated.

## Маршруты и prompts

Topology, политики, retry, fanout и prompt-файлы принадлежат immutable route bundle. В
profile.sh их дубликатов нет. Каждый исполняемый узел задаёт:

- id, runKey и executor;
- policy.filesystem, policy.browser, policy.timeoutClass;
- single/parallel policy в fanout: parallel допустим только для `state-only` agent-узла;
  `degrade=forbid` требует native fanout, `allow-single` разрешает явное последовательное
  выполнение независимых ролей одним runner-ом;
- допустимые outcomes и переходы;
- required context и project-specific prompt-файл.

Для debug заранее объявляется instrumentation scope. Чисто машинные проверки syntax/hash/lint
лучше оформлять `executor=command` через allowlisted profile hook, а не тратить на них LLM-узел.
Узлы metrics и browser должны останавливать маршрут у человека, если обязательное доказательство
невозможно получить.

Не ставь `retry.productFailure > 0` узлу, у которого `on.failed` делает `rewind`. Сначала
исполняется retry того же узла на прежнем входе и только потом rewind, поэтому проверяющий
повторит то же замечание вместо возврата к автору. Общий валидатор отклоняет такую схему.

Проверяй source-каталог без live-публикации, затем публикуй в временный store и перечитывай
каждый immutable hash. Только после зелёных offline-проверок выполняются CAS-публикация live
catalog и отдельное включение capability. Эти два действия нельзя менять местами.

## Проверки

Структурная проверка без GrigDesk и model call:

~~~bash
engine/bin/factory-check <name> --quick
~~~

Она проверяет capability и hooks, canonical runner config и форму хоста стенда.
Определения маршрутов, prompts, переходы и no-ship topology проверяет локальный тест source-каталога
профиля до публикации.

~~~bash
node profiles/<name>/routes/publish.mjs --validate
~~~

На рабочем хосте после настройки CLI/auth:

~~~bash
RUN_HOST_PREFLIGHT=1 engine/bin/factory-check <name> --host-preflight
~~~

Preflight не отправляет model prompt. Live-пилот требует отдельного разрешения человека и не
должен автоматически создавать delivery, запускать shared-стенд или очищать чужой checkout.
