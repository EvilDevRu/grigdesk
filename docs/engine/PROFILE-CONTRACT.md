# Контракт профиля проекта

Профиль отделяет project-specific работу от движка. Для профиля `<name>` обязательны:

```text
profiles/<name>/
  profile.sh
  runners.env
  graph.json
  dashboard.env
```

Дополнительные скрипты стенда, демо и интеграций лежат в том же каталоге профиля.
Корневой `/profiles/` целиком игнорируется Git. Профили разворачиваются и резервируются
как локальная конфигурация окружения; движок и тесты репозитория не должны зависеть
от наличия профилей с конкретными именами.

## Runner policy

`profiles/<name>/runners.env` — единственный project source для выбора ИИ и моделей. Без валидного
файла запуск останавливается до model call.

Минимум:

```text
RUNNERS_SCHEMA=1
CONFIG_REVISION=1
RUNNERS_COVERAGE=required
PROJECT_RUNNER_PRIMARY=claude
PROJECT_RUNNER_FAILOVER=codex
```

Настраивать нужно через CLI, чтобы сохранить revision/CAS:

```bash
engine/bin/factory profile <name> runner show
engine/bin/factory profile <name> runner set claude --failover codex
engine/bin/factory profile <name> runner set REVIEW codex --failover claude
engine/bin/factory profile <name> model set DEFAULT claude \
  family=opus version=latest effort=max
engine/bin/factory profile <name> model set DEFAULT codex \
  family=sol version=latest effort=xhigh
```

Primary/failover принадлежат проекту. Task override не меняет профиль:

```bash
engine/bin/factory <TASK> runner set codex --failover claude
engine/bin/factory <TASK> runner set REVIEW claude --failover codex
engine/bin/factory <TASK> runner clear REVIEW
```

Routing precedence:

```text
task-stage → task → profile-stage → profile-project
```

Модель задаётся семейством. `version=latest` обновляет actual id только внутри семейства;
неизвестный exact id движок не угадывает.

После изменения runner/model policy нужен metadata-only preflight:

```bash
RUN_HOST_PREFLIGHT=1 engine/bin/factory-check <name> --host-preflight
```

Он не отправляет prompt. Пока coverage отсутствует, просрочено или несовместимо, запуск
блокируется до model call.

## Обязательные переменные `.sh`

| Переменная | Смысл |
|---|---|
| `PROFILE_NAME` | имя профиля |
| `PROFILE_CTX` | стек, правила, проектные запреты для каждого prompt |
| `PROFILE_AGENT_CWD` | базовый рабочий каталог агента |
| `PROFILE_ROUTE_STAGES_<route>` | bash-массив этапов маршрута |

Пример:

```bash
PROFILE_ROUTE_STAGES_feature=(SCOUT PLAN GATE_PLAN TESTS BUILD REVIEW GATE_ACCEPT)
PROFILE_ROUTE_STAGES_trivial=(SCOUT BUILD REVIEW GATE_ACCEPT)
```

Этапы `GATE_*` обрабатывает движок: они не требуют prompt и ждут решения человека.

## Обязательные хуки

- `profile_sandbox_up <TASK>` — идемпотентно подготовить стенд;
- `profile_sandbox_down <TASK>` — снести стенд по явному действию оператора;
- `profile_sandbox_exists <TASK>` — вывести непустое значение, если стенд готов;
- `profile_stage_prompt <TASK> <STAGE>` — вернуть project-specific задание этапа.

Профиль подгружается заново перед каждым этапом. Исправленный prompt/budget подхватится без
рестарта демона; синтаксически битая новая версия не должна заменять уже загруженную.

## Опциональные хуки

| Хук | Назначение |
|---|---|
| `profile_route <TASK>` | детерминированно выбрать route без SCOUT |
| `profile_slots` | вернуть `RANGE`/`USED` для распределения стендов |
| `profile_agent_cwd <TASK>` | выбрать worktree конкретной задачи |
| `profile_stage_budget <STAGE>` | ориентир глубины в минутах |
| `profile_stage_timeout <STAGE>` | жёсткий timeout в секундах |
| `profile_stage_fanout <STAGE>` | `AUTO min-max` или фиксированные зоны |
| `profile_stage_readonly <STAGE>` | объявить проверочный этап read-only |
| `profile_dirty_files <TASK>` | перечислить изменённые файлы |
| `profile_revert_files <TASK> ...` | project-specific восстановление при opt-in autorevert |

`PROFILE_ARCHIVE_ON_FINISH=1` архивирует завершённую карточку автоматически.

Хуки выбора runner/model в `.sh` не являются частью контракта и runtime их не читает.

## Доступ агента

Доступ к путям и командам задаётся отдельно:

- `PROFILE_AGENT_CWD` — рабочий каталог;
- `PROFILE_AGENT_DIRS` — дополнительные каталоги вне cwd;
- `PROFILE_AGENT_ALLOW` — project-specific разрешённые команды;
- `PROFILE_AGENT_DENY` — project-specific запрещённые команды.

Движок сам разрешает только scoped status API:

```text
engine/lib/stage-result.sh
engine/lib/stage-progress.sh
```

Общий `pipeline-set.sh` агенту не выдаётся. Он остаётся control writer-ом движка.
Для Codex дополнительные каталоги переводятся в `--add-dir`; sandbox остаётся
`workspace-write`.

Read-only этап защищается двумя слоями:

1. deny правил для очевидных writer/auto-fix команд;
2. сравнением project diff до и после этапа.

При нарушении этап падает, а файлы по умолчанию не изменяются движком. Автовосстановление
включается только через `FACTORY_AUTOREVERT=1`; untracked файлы должны попасть в quarantine.

## Status protocol v2

Попытка этапа получает `run_id`, `epoch` и capability token через унаследованный FD.

Terminal результат:

```text
stage-result --task N --stage BUILD --run-id ... --epoch ... done
stage-result ... skipped "причина"
stage-result ... failed "причина"
```

Точную команду движок добавляет к prompt перед запуском. Профиль должен формулировать условия
`done`, `skipped` и `failed`, но не собирать run-id/token самостоятельно.

Для нетерминальных данных есть `stage-progress`. Допустимы только:

- `ROUTE`, `ROUTE_BY`, `SIZE`, `TRIVIAL_ESCALATED`;
- `PLANS`, `SKEPTIC`, `VALIDATE`, `TRANSLATOR`.

Примеры формулировок prompt:

```text
Опубликуй ROUTE dev ROUTE_BY scout через добавленную stage-progress команду,
затем заверши stage-result done.

Опубликуй PLANS done SKEPTIC done VALIDATE done TRANSLATOR done,
затем заверши stage-result done.
```

`ROUTE_BY=human` может выставить только control path. Агенту разрешены `scout` и `escalation`.

Terminal result принимается compare-and-set только для активных `run_id + epoch + token`.
Поздний ответ предыдущей попытки отклоняется.

## Prompt этапа

Хороший `profile_stage_prompt` отвечает на четыре вопроса:

1. что сделать;
2. откуда взять вход и куда записать артефакт;
3. какой project-specific командой проверить результат;
4. при каких условиях завершить `done`, `skipped` или `failed`.

Для проверочного этапа эти исходы обязаны различать дефект продукта и возможности runner-а:

- проверка реально запустилась и доказала дефект — `failed`;
- проверка прошла — `done`;
- проверка не смогла стартовать из-за sandbox/network/Docker/отсутствующего инструмента —
  `skipped` с точной причиной и списком непроверенного.

Недоступность среды резервного ИИ нельзя выдавать за дефект кода и возвращать в BUILD:
иначе совместимый failover формально срабатывает, но конвейер зацикливается на проверке,
которую этот runner физически не может выполнить.

То же правило действует для проверок внутри `BUILD`: невозможность запустить тест из-за
изоляции runner-а фиксируется как непроверенный риск, а не как доказанный дефект реализации.
Если линтер проверяет целые изменённые файлы, профиль обязан отделять новые нарушения от
долга в базовой версии. Ненулевой exit code без сравнения с baseline не является основанием
возвращать задачу в `BUILD`.

Следующий этап должен читать подготовленный артефакт, а не повторно сканировать весь проект.
Background workflow запускать нельзя: этап синхронный, а фоновой процесс осиротеет.

## Fanout и budget

`profile_stage_fanout`:

```bash
profile_stage_fanout() {
  case "$1" in
    SCOUT)
      printf '%s\n' 'AUTO 3-8' 'Делить по реально затронутым подсистемам.'
      ;;
    *) printf '\n' ;;
  esac
}
```

Fanout подходит для независимого чтения/ревью. Он не подходит для параллельной записи в один
worktree или замеров на одном стенде.

`profile_stage_budget` ограничивает глубину, `profile_stage_timeout` — длительность процесса.
Фактическая длительность и fanout пишутся движком в telemetry.

## Схема Cockpit

`profiles/<name>/graph.json` обязательна: Cockpit не строит fallback-схему.

Схема содержит:

- узлы и координаты;
- route edges и петли возврата;
- `keys`, если id узла не совпадает с pipeline key;
- `runner_keys`, если визуальный узел является внутренней фазой другого runner-stage;
  поддерживаются общий раздел `*` и route-specific оверрайд;
- `optional` — этапы, для которых `skipped` является нормальным.

`optional` читает UI, а не движок. Причина `skipped` обязательна в любом случае.

После изменения маршрутов:

```bash
engine/bin/factory-graph-new <name> --force
python3 tests/engine/routes-sync.py <name>
```

## Debug

Debug не является profile hook:

```bash
engine/bin/factory profile <name> debug set verbose --for 2h
engine/bin/factory profile <name> debug clear
```

Настройка хранится отдельно от runner config, не меняет routing revision и не выдаёт агенту
новых прав. Prompt, credentials и capability token в trace не пишутся.

## Проверка профиля

Без Cockpit и model call:

```bash
engine/bin/factory-check <name> --quick
```

На рабочем хосте перед canary:

```bash
RUN_HOST_PREFLIGHT=1 engine/bin/factory-check <name> --host-preflight
```

Проверки должны подтвердить:

- обязательные файлы и hooks;
- canonical runner config;
- route/graph sync;
- доступы к путям;
- prompt каждого stage;
- model policy и coverage;
- безопасность status protocol.
