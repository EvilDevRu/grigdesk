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

Task-level override можно закрепить уже на старте прогона:

```bash
engine/bin/factory <TASK> start --profile <name> --route <route> --ticket-json <abs> \
  --runner-primary codex
```

Id валидируется по установленным адаптерам (та же выборка, что `factory runners`). Движок
пишет `RUNNER_OVERRIDE_PRIMARY=<id>` и `RUNNER_OVERRIDE_FAILOVER` — профильный failover без
выбранного id (task override целиком замещает пару primary/failover, профильный failover сам
не подмешивается). Флаг допустим только при `start`; override хранится в реестре задачи и
переживает resume. В Cockpit тот же override выставляет селект исполнителя в форме запуска,
а stage override — модалка узла (`POST /api/tasks/:id/runner/override` → `runner set/clear
<STAGE>`; работающий этап — только `runner switch`).

Routing precedence:

```text
task-stage → task → profile-stage → profile-project
```

Модель задаётся семейством. `version=latest` обновляет actual id только внутри семейства;
неизвестный exact id движок не угадывает.

Route bundle не хранит `provider`, `model` или `effort`. Исполняемый узел задаёт только
`runKey`; по нему движок выбирает stage-policy `MODEL_<RUN_KEY>_<PROVIDER>_*` с fallback
на `MODEL_DEFAULT_<PROVIDER>_*` из `runners.env`. Поэтому опубликованный маршрут остаётся
provider-neutral, а смена модели или effort не требует публикации новой схемы.

Допустимые семейства объявляет сам раннер (`runner_<provider>_family_alias`), потому что без
каталога семейство уходит в CLI как имя модели: у `claude` это `opus|fable|sonnet|haiku`,
у `codex` семейных алиасов нет — там семейство обязано прийти из каталога.

**`AUTO_COMPACT_WINDOW`** — необязательный ключ того же файла: порог автосжатия контекста
ЭТАПА в токенах (`0` или отсутствие — не вмешиваться). Он читается только как **резерв**:
запуск из кокпита передаёт своё значение переменной `FACTORY_STAGE_AUTO_COMPACT` и всегда,
включая осознанный `0`, — иначе выбор человека молча проигрывал бы настройке проекта. Профиль
отвечает за запуски из CLI. Дальше движок отдаёт разрешённое число раннеру своим
`RUNNER_AUTO_COMPACT_WINDOW`, и диалект CLI знает уже раннер, не профиль
(см. [ENGINE.md](ENGINE.md)).

После изменения runner/model policy нужен metadata-only preflight:

```bash
RUN_HOST_PREFLIGHT=1 engine/bin/factory-check <name> --host-preflight
```

Он не отправляет prompt. Пока coverage отсутствует, просрочено или несовместимо, запуск
блокируется до model call.

## Переменные `profile.sh`

| Переменная | Смысл |
|---|---|
| `PROFILE_NAME` | имя профиля |
| `PROFILE_CTX` | общий стек, правила и проектные запреты для agent context |
| `PROFILE_AGENT_CWD` | базовый рабочий каталог агента; route launcher закрепляет его по первому repository |
| `PROFILE_AGENT_DIRS` | дополнительные разрешённые каталоги |
| `PROFILE_AGENT_ALLOW` / `PROFILE_AGENT_DENY` | project-specific command policy |
| `PROFILE_SERVICE_HOST` | hostname без схемы и порта |
| `LESSONS_DIR` | каталог уроков RETRO внутри первого repository; по умолчанию `docs/lessons` |

`LESSONS_DIR` — относительный путь без `..` и ведущего слэша; движок отвергает остальное,
иначе RETRO записал бы урок мимо рабочей копии. Структура репозитория — знание профиля:
у одного проекта уроки логично лежат в `docs/`, у другого — в `.claude/` рядом со знаниями
агентов. Само значение попадает в `artifacts.lessonsRepo` (см. ниже).

Topology и prompt-файлы не задаются shell-массивами или функциями профиля. Они читаются только
из опубликованного immutable route bundle. Обязательные workspace/stand hooks перечислены ниже
в разделе «Route protocol».

## Опциональные route hooks

| Хук | Назначение |
|---|---|
| `profile_timeout_class <CLASS>` | переопределить секунды класса времени из бандла маршрута |
| `profile_stage_agent_allow <RUN_KEY>` | добавить узкому route-узлу project command |
| `profile_route_node_evidence_check ...` | trusted-проверка evidence exact run и снимок его артефактов |
| `profile_agent_control_start <TASK> <RUN_KEY>` / `profile_agent_control_stop <TASK> <RUN_KEY> <RC>` | краткоживущий project control channel для exact stage |

Хуки выбора runner/model в `.sh` не являются частью контракта и runtime их не читает.

## Доступ агента

Доступ к путям и командам задаётся отдельно:

- `PROFILE_AGENT_CWD` — рабочий каталог;
- `PROFILE_AGENT_DIRS` — дополнительные каталоги вне cwd;
- `PROFILE_AGENT_ALLOW` — project-specific разрешённые команды;
- `PROFILE_AGENT_DENY` — project-specific запрещённые команды.

Общие безопасные команды остаются в `PROFILE_AGENT_ALLOW`. Разрешение, нужное только роли
узла, профиль возвращает построчно из необязательного
`profile_stage_agent_allow <RUN_KEY>`. В частности, delivery CLI (`gh`, tracker) выдаются
только `SHIP`, а не всему профилю: маршрут без `ship` не должен получить их ни на одном узле.
Это сужение команд, но не изоляция секретов — общий `HOME` и сетевой стек остаются отдельной
границей hardening.

Движок сам разрешает только scoped status API:

```text
engine/lib/stage-result.sh
engine/lib/stage-progress.sh
```

Общий `pipeline-set.sh` агенту не выдаётся. Это ограниченный writer неслужебных полей
вторичной проекции; topology, lifecycle, provenance и route statuses принадлежат только
host/control writer и run-scoped capability API.
Для Codex дополнительные каталоги переводятся в `--add-dir`; sandbox остаётся
`workspace-write`.

Control hooks объявляются только парой. `start` обязан создать отдельный canonical
owner-only каталог mode `0700`, запустить trusted broker и экспортировать его как
`PROFILE_AGENT_CONTROL_DIR`; `stop` вызывается после любого результата runner-а и проверяет
безопасное завершение/cleanup. Это не writable workspace: restricted Codex проверяет exact
path/owner/mode/non-symlink, отклоняет пересечение с любым `--add-dir` и монтирует каталог
только как `read`. Project protocol внутри может использовать FIFO/regular lock: FIFO I/O и
`flock` работают через read-only bind, поэтому network proxy, localhost/TCP и AF_UNIX для
host-channel не нужны. Сам broker остаётся host-процессом с закрытым whitelist; каталог не
может выдавать агенту произвольный lifecycle API.

Claude route runner доступен только для аудированной native CLI `2.1.220`. Engine передаёт
ему один файл `--settings` из приватного `CONTROL_DIR` (regular, owner-only, mode `0400`) и
запускает с `--setting-sources ''`, `--strict-mcp-config` без `--mcp-config`
и `--disable-slash-commands`. Так user/project/local settings, hooks, skills и произвольные
MCP не расширяют route policy; credential store при этом не отключается (`--bare` запрещён).
`--safe-mode` снят намеренно: агентам конвейера нужна память проекта (CLAUDE.md с
@-импортами знаний) из worktree, а hooks/skills/MCP остаются закрытыми перечисленными
флагами.
Файл требует native Bash sandbox `enabled=true`, `failIfUnavailable=true`, запрещает
unsandboxed escape hatch и не содержит `excludedCommands`. `CONTROL_DIR` закрыт одновременно
через `sandbox.filesystem.denyRead/denyWrite` и deny правил инструментов
`Read/Edit/Write/NotebookEdit`. Другая версия CLI считается unavailable до повторного аудита.

Разрешение сверяется по префиксу строки, поэтому на проверочных этапах движок запрещает
запускатели чужих команд (`timeout`, `env`, `xargs`, `nohup`, `setsid`, `stdbuf`, `nice`,
`sudo`, `sh -c`, `bash -c`): иначе `timeout git commit …` проходит мимо запрета на коммит.
Запрет действует и на скрипты профиля — если проектной команде нужна обёртка, заворачивай её
внутрь своего скрипта и разрешай уже сам скрипт. Так же решается и обратная задача: команду
с обязательными переменными окружения (`E2E_BASE_URL=… npx playwright test`) одним префиксом
не выразить, поэтому её место — исполняемый файл профиля в `PROFILE_AGENT_ALLOW`. Иначе
проверяющий этап не найдёт разрешённой формы запуска e2e и примет падение спек на веру,
хотя на живом стенде они зелёные.

Route-узел с `policy.filesystem=state-only` защищается двумя слоями:

1. deny правил для очевидных writer/auto-fix команд;
2. точным host-снимком workspace до и после exact run.

При нарушении этап останавливается с `STALLED_HUMAN=1`. Движок ничего не откатывает:
обычный readonly guard не владеет изменением и не может безопасно отличить запись агента
от параллельной правки человека.

Это backstop, а не самостоятельная host-level sandbox. Основную границу `state-only` обязан
обеспечивать runner, который физически не выдаёт source roots на запись; у Claude Bash-процессы
дополнительно исполняются только внутри обязательной native OS sandbox.

## Временная инструментация

Для `trace → verify` используется host-controlled API
`engine/lib/instrumentation-transaction.sh`:

```text
instrumentation_tx_begin TASK TXID SCOPE_FILE FACTORY-TRACE:tTASK GIT_ROOT...
instrumentation_tx_checkpoint TASK TXID
instrumentation_tx_cleanup TASK TXID
```

Способ получения scope задаёт опубликованная topology, а не имя маршрута. Транзакционный
узел `instrument` означает `explicit`: вызывающий обязан передать точные repo-relative пути
на `start`, после чего scope закрепляется immutable-артефактом попытки. Для прочего
исторического `transactional-write` действует `derived`: движок собирает scope из diff перед
узлом. Без транзакционных узлов режим `disabled`, и явный scope отклоняется. Поэтому новый
алиас или переименование диагностического маршрута не требует изменений launcher-а, профиля
или Cockpit; изменение самой topology меняет контракт и проверяется через `factory check`.

В isolated-режиме host выдаёт linked worktree только одной попытке и устанавливает
`FACTORY_INSTRUMENTATION_ISOLATION=exclusive-worktree-v1`. В explicit shared-режиме допустим
primary checkout с `exclusive-shared-checkout-v1`, но только после trusted-проверки exact durable
lease на workspace и стенд. Реестр аренды не передаётся provider-процессу.

До `begin` scope содержит точные абсолютные имена файлов. Пути с `..`, каталогами,
`.git` и symlink-родителями наружу отклоняются. `checkpoint` разрешает изменения только
в scope. `cleanup` сначала делает CAS-сверку ожидаемого workspace, затем восстанавливает
только файлы и index, которыми владеет транзакция, и доказывает возврат к baseline.
При параллельной правке возвращается конфликт, чужое содержимое не перезаписывается.
Перед первым restore durable-состояние меняется на `cleaning`; после падения повторный
cleanup принимает только покомпонентную смесь expected/baseline и безопасно продолжает.

Маркер строго task-specific: `FACTORY-TRACE:t<TASK>`. Старый маркер до начала или маркер
после cleanup считается ошибкой. Транзакция не открывается из произвольного agent prompt:
её жизненным циклом управляет host runtime после отдельного объявления scope.

Состояние транзакции, baseline и backups находятся под `FACTORY_CONTROL_ROOT`, а не
в provider-writable `STATE_DIR`. Эти каталоги не добавляются runner-у как writable roots.

### Самодостаточное рабочее дерево — без общих inode

Сторож транзакции следит за трекаемыми файлами и объявленным scope. Игнорируемые git
файлы — логи, кэши, `vendor`, `node_modules`, `.env` — под наблюдение не попадают вовсе,
поэтому мусор работающего стенда его не касается и объявлять исключения не нужно.

Взамен профиль обязан отдавать рабочее дерево, правки в котором **не выходят за пределы
песочницы**. Практически это одно требование: не клонировать зависимости хардлинками.

`cp -al` делает каталог зависимостей песочницы и основного репозитория одними и теми же
файлами. Любая запись — прогон тестов, кэш инструмента, сборка — меняет их разом везде.
В наблюдавшемся прогоне тестовый раннер записал служебный файл при `nlink=7`: в основной
репозиторий и шесть соседних рабочих деревьев одновременно, то есть мог уронить чужую
транзакцию, к которой не имел никакого отношения.

Правильно — полная копия:

```sh
cp -a "$REPO/vendor" "$WORKTREE/vendor"     # не cp -al
```

Цена замерена на 261 МБ и 15 тысяч файлов: 0.93 с против 0.35 с у хардлинков. На фоне
подъёма песочницы в 20–25 минут это ничто, а `node_modules` в 676 МБ и так копируется
целиком — хардлинки для него невозможны, часть файлов принадлежит uid контейнера.

Проверить это статически движок не может: рабочее дерево существует только под живую
задачу. Требование держится на профиле.

Чего сторож не делает и никогда не делал: он сравнивает две точки — `begin` и
`checkpoint`. Всё, что изменили и вернули между ними, для него не существует. Защитой
от намеренного подлога он не является, и строить её на нём не нужно.

> `PROFILE_VOLATILE_PATHS` отменён. Если переменная осталась в профиле — она мёртвая,
> движок её не читает. Почему список исключений оказался тупиком, расписано над
> `_instrumentation_tx_snapshot` в `engine/lib/instrumentation-transaction.sh`.

### `PROFILE_SERVICE_HOST` — под каким именем открывать стенд

Адрес стенда движок собирает сам: `http://<host>:<порт>` уезжает агенту в
`services.frontendUrl` и `services.apiUrl`. Порты приходят из закреплённого workspace contract,
а имя хоста — слово проекта:

```sh
PROFILE_SERVICE_HOST="localhost"   # умолчание: 127.0.0.1
```

Разница не косметическая. Приложение вправе решать «локальный запуск или прод» по
`window.location.hostname`, и тогда петлевой адрес переключает фронт в продовый режим:
другой эндпоинт авторизации, другой путь логина, поведение, которого в песочнице нет.
В одном прогоне приёмка открыла стенд по `127.0.0.1`, фронт ожидал `localhost`, счёл себя
production-сборкой, получил 401 и ушёл на отсутствующий в песочнице маршрут авторизации.
Гвард роутера дописывал `?redirect=` и перезагружал страницу заново — после десятков
витков браузер перестал отвечать, а узел `browser` исчерпал лимит без единого сценария.

Значение — голое имя хоста или адрес: без схемы, порта и слэшей (их добавляет движок).
Форму проверяет `factory-check`, чтобы ошибка не всплыла на живом прогоне.

## Route protocol: capability и workspace

Исполняемый движок один: `factory`. Профиль обязан заявить семантическую capability
`"route-v2"` в `graph.json`; профиль без неё не получает старый launcher или fallback,
а завершается fail-closed до lifecycle-действий.

Обязательные хуки `profile.sh`:

| Хук | Возвращает |
|---|---|
| `profile_workspace_mode` | ровно `isolated` или `shared` |
| `profile_repositories TASK` | 1–16 строк `имя<TAB>source<TAB>workspace`; первый repo — основной cwd |
| `profile_project_context` | JSON ровно с `stack: string[]` и `guardrails: string[]` |
| `profile_source_branch TASK REPO` | закрепляемую ветку **этого** репозитория (`REPO` — имя из `profile_repositories`) |
| `profile_container TASK` | имя стенда/контейнера для typed context и resource lease |
| `profile_stand_alive TASK` | только health существующего стенда, без create/start/delete |

Для запуска publish-маршрутов из Cockpit профиль обязан объявить
`profile_delivery_targets TASK`: по одной строке `имя-repo<TAB>целевая-ветка` для каждого
репозитория из `profile_repositories`. Это trusted-конфигурация Cockpit, а не
редактируемый ввод браузера: сервер передаёт её движку явными `--delivery-target`.
Сам движок ветки по profile hook не угадывает; прямой CLI-запуск по-прежнему обязан
передать targets явно.

Опциональный `profile_delivery_actions TASK` перечисляет дополнительные действия
доставки — по одной строке на действие из словаря движка (сегодня это `task-comment`;
обязательная для publish тройка commit/push/pull-request профилем не отключается).
Каждое перечисленное действие Cockpit передаёт движку его флагом (`--task-comment`),
неизвестное или повторное значение отклоняет запуск. Отсутствие хука или пустой вывод —
ничего дополнительного не разрешено. Как и targets, это trusted-конфигурация профиля:
набор действий принадлежит проекту, а не кокпиту.

`source` всегда существует и каноничен. В `isolated` workspace — нормализованный
планируемый путь, строго не пересекающийся ни с одним source; его создаёт профильный
`up.sh`. В `shared` workspace обязан **точно совпадать** с source, быть существующим
primary Git checkout (`git-dir == git-common-dir`) и находиться на ветке из
`profile_source_branch`. Равенство путей никогда не выводится эвристикой и не разрешает
ослабить isolated-режим.

Движок зовёт `profile_source_branch` **по разу на каждый репозиторий**, передавая его имя
вторым аргументом. Профиль, который второй аргумент игнорирует, объявляет одну ветку на
всех — так работали все профили до этого хука, и правки они не требуют. Расхождение веток
между репозиториями допустимо **только в `shared`**: там ветка описывает уже существующий
checkout человека, а у проекта из нескольких репозиториев каноничные ветки могут не
совпадать (`repo-a` использует `main`, `repo-b` — `master`). В `isolated` это имя вновь
создаваемой ветки задачи, одной на всю попытку, поэтому разные значения движок отвергает
fail-closed (код 78). Singleton `source-branch` в манифесте попытки и
`delivery.sourceBranch` в typed context — всегда ветка первого (основного) репозитория;
своя ветка каждого доступна агенту как `workspace.<repo>.branch`, а целевые ветки
доставки задаются отдельно через `profile_delivery_targets`.

`bin/factory-check --quick` сверяет фактический HEAD каждого shared checkout с его пином и
проверяет, что isolated-профиль закрепил одну ветку на все репозитории. Без этой сверки
расхождение всплывало только отказом движка на первом же действии по задаче — включая
приёмку уже сделанной работы.

Shared-профиль дополнительно реализует:

| Хук | Возвращает |
|---|---|
| `profile_service_ports TASK` | одна строка `FE_PORT<TAB>API_PORT` |
| `profile_exclusive_resources TASK` | стабильные строки ресурсов, включая exact `workspace:<path>` и `stand:<name>`; общий GPU объявляется одинаковым ключом |
| `profile_instrumentation_restored TASK SCOPE_FILE` | exact sync восстановленного scope во внешний стенд и health; без создания/удаления ресурсов |

Движок захватывает каждый exclusive resource CAS-арендой в trusted control root.
Аренда закреплена за exact task/attempt, переживает завершение foreground-команды и
human gates и снимается только после `completed` либо успешного `abandon`. Поэтому
обычный процессный `flock` не считается защитой shared checkout/GPU. `resume`, `gate`
и `goto` exact-проверяют владельца; `recover` получает новую аренду. При незавершённой
instrumentation или ошибке post-restore hook аренда остаётся занята.

Shared launcher не вызывает `up.sh`/`down.sh`, не создаёт task-env, worktree, контейнер
или volume силами профиля и не стартует остановленный стенд. Он только проверяет health
и атомарно пишет engine-owned projection `STATE_DIR/t<TASK>.env` с
`WORKSPACE_MODE=shared`, `STAND_OWNERSHIP=external`, service metadata и точными
`REPO_<N>_{NAME,SOURCE,WT,BRANCH}`. Этот файл не передаёт движку ownership внешнего
checkout/стенда; destructive sandbox endpoints обязаны его сохранять.

Для isolated `up.sh` пишет тот же generic repo-набор плюс `SB_K`,
`API_PORT`, `FE_PORT` и `SOURCE_BRANCH`; launcher exact-сверяет все значения. Старых
backend/frontend hooks и `BE_WT/FE_WT` fallback в исполняемом контракте нет.

Repo/project/mode/branch/stand/ports/resources закрепляются immutable artifact-ом
попытки. `resume` останавливается при любом дрейфе. Для маршрута с `ship` каждый
delivery target задаётся как `имя-repo=ветка` для имени из `profile_repositories`;
маршрут без `ship` не получает delivery actions. Typed context принимает список через
`factory-context --repo имя:workspace:source:branch` и публикует его под именами профиля.
Трёхпольная форма без `branch` остаётся rolling-upgrade совместимостью для launcher-процесса,
который уже работал в момент замены отдельного `factory-context`; тогда берётся общий
закреплённый `--source-branch`. Новые запуски всегда передают четырёхпольную форму.

Транзакционная instrumentation в isolated по-прежнему требует linked worktree. Primary
checkout разрешён только в explicit shared mode после проверки exact durable lease.
Cleanup использует прежний CAS и восстанавливает исходно dirty baseline побайтово; затем
обязателен `profile_instrumentation_restored`. Любая параллельная неизвестная правка или
ошибка sync останавливает попытку и ничего не перезаписывает молча.

Файловая политика узла дополнена явным разрешением браузера:
`policy.browser: forbid|allow` (умолчание `forbid`). Разрешение независимо от
`policy.filesystem` — узел приёмки бывает `state-only`, но браузер ему нужен, а
разведке и планированию он не положен даже при доступной записи. При `forbid`
движок кладёт `mcp__playwright*` в deny-правила запуска: браузер физически
недоступен агенту, а не «не рекомендован промптом».

Исполняемый узел route v2 обязан иметь `node.id == node.runKey.toLowerCase()`: Cockpit и
trusted runtime выводят ключ ворот/статуса из этой связи и отклоняют неоднозначный bundle.
`timeoutClass` выбирается только из классов, известных движку. У маршрута с узлом `ship`
этот узел канонический (`SHIP`, tail, `workspace-write`, класс `delivery`, required context
`delivery`). Маршрут без `ship` не получает delivery-файл, actions или targets, а typed context
содержит `delivery.mode=disabled`.

Профиль может объявить `profile_route_node_evidence_check TASK ROUTE NODE RUN_KEY OUTCOME
RUN_ID CONTEXT_FILE`. Диспетчер вызывает его после runner и `state-only` guard для точного
`runId`; последний аргумент — owner-only typed context именно этого запуска. Ненулевой
результат превращает заявленный runner-ом `done/skipped` в продуктовый `failed`, чтобы переход
машины остановил недоказанный результат у человека, а не ретраил его как no-result.
Доверенные снимки такого hook должны лежать внутри `ROUTE_V2_ATTEMPT_DIR`/`FACTORY_CONTROL_ROOT`;
копия в provider-writable `STATE_DIR` может использоваться для отчёта и UI, но не как источник
истины следующей проверки. Проверка обязана связывать снимок с точным `runId` и не засчитывать
команду декларации evidence как чтение проверяемого исходника.

Для `executor=command` профиль объявляет доверенный hook:

```text
profile_route_command TASK ROUTE NODE RUN_KEY COMMAND_ID CONTEXT_FILE
```

`COMMAND_ID` — только идентификатор из закреплённого bundle, не shell-строка. Профиль обязан
сопоставить его с заранее известной реализацией и отклонить всё остальное; движок никогда не
исполняет содержимое bundle через shell. Command-узел объявляет `fanout: single/1/forbid`,
нулевые `noResult`/`productFailure`/`providerFailure.attempts` и стратегию `none`. Допустимы
`state-only` и `workspace-write`; для проверок предпочтителен `state-only` со сторожем.

Hook пишет в stdout ровно один JSON-объект:

```json
{
  "schema": 1,
  "outcome": "failed",
  "comment": "краткий итог",
  "failureOwner": "build",
  "findings": [{"id": "stable-contract-id", "summary": "проверяемое замечание"}]
}
```

Для `skipped` нужны `failureOwner: null` и пустой `findings`; `failed` требует владельца
и 1–32 findings с **уникальными** `id` (то же правило формы, что у `stage-result` ниже).

`done` может нести findings, но только отложенные — каждый с `"severity": "deferred"`.
Это приёмка с хвостом: работа принята, а найденное вне цели задачи уезжает к человеку на
ворота, не разворачивая сборку. Блокирующее замечание при `done` (явное `"blocking"` или
поле опущено) отвергается как противоречие. Обратное тоже нормализуется: `failed`, в котором
не осталось ни одного блокирующего замечания, движок выпрямляет в `done` с тем же хвостом —
возвращать работу автору не за что. Отсутствие `severity` читается как `"blocking"`, поэтому
скрипты, написанные до появления поля, менять не нужно.
Ненулевой exit, лишние поля или невалидный JSON считаются отказом trusted
host-команды и не превращаются в продуктовый исход. Так детерминированные SHA/check/test
проверки выполняются до семантического LLM-review и не расходуют model call.

Цена нарушения — не «отклонённое поле», а вставший маршрут: вердикт разбирается ПОСЛЕ того,
как команда отработала и записала свои артефакты, поэтому непринятый JSON даёт
`dispatcher остановлен fail-closed (код 78)` на узле, который фактически выполнен. Узел не
коммитится, `STALLED_HUMAN=1`, `resume` упирается ровно в то же место — детерминированно,
без вмешательства человека маршрут не поедет. Диагностика: `t<TASK>.stages.log` — «код 78»
сразу за «узел <N>: подготовка к исполнению», при этом `t<TASK>.route-v2.log` пуст (модель не
звалась), а артефакты узла на диске свежие.

Поэтому диагностику (кто из провайдеров выпал, что пропущено) command-узел кладёт в `comment`
и в собственные артефакты-сводки, а `findings` отдаёт только вместе с `failed` и по одному на
причину: список «по одному finding на каждый выпавший элемент» ломается сам собой, как только
элементов становится двое — одинаковые `id` движок отвергает.

Тест профиля обязан прогонять stdout hook-а через настоящий парсер движка:

```bash
source engine/lib/route-runtime.sh; _route_v2_command_result RESULT_JSON
```

Схема profile-скрипта всегда шире контракта движка, и проверки одного лишь JSON на выходе
скрипта рассинхрон не ловят. На этом уже вставал боевой маршрут с кворумом нескольких мнений:
тест профиля прямо закреплял ассертом `done` с информационным `findings` — форму, которую
движок не принимает, — и маршрут останавливался каждый раз, когда один исполнитель не отвечал.

## Status protocol v2

Попытка этапа получает `run_id`, `epoch` и capability token через унаследованный FD.

Terminal результат:

```text
stage-result --task N --stage BUILD --run-id ... --epoch ... done
stage-result ... skipped "причина"
stage-result ... failed "причина"
stage-result ... --failure-owner build \
  --finding "stable-contract-id=краткое проверяемое замечание" failed "причина"
stage-result ... --finding-deferred "stable-id=дефект вне цели задачи" done "что принято"
```

Точную команду движок добавляет к prompt перед запуском. Профиль должен формулировать условия
`done`, `skipped` и `failed`, но не собирать run-id/token самостоятельно.

`--finding` и `--finding-deferred` различают вес замечания. Первое возвращает работу автору,
второе — нет: отложенная находка не открывает цикл ремонта, не участвует в сторожах топтания
и живёт до ворот приёмки, где движок выкладывает её человеку в `t<task>.deferred.md`. Отказ
из одних отложенных находок выпрямляется в `done`. Блокирующим может быть только то, что
ломает цель самой задачи или является регрессией ранее работавшего; требование, недоказуемое
на текущем стенде, блокирующим быть не может — это отложенная находка с указанием, где её
проверять.

Typed `failed` допускает ровно одного владельца пачки:

- `build` — дефект реализации продукта;
- `tests` — неверный, нестабильный или неполный тест;
- `environment` — стенд, зависимости или локальная конфигурация;
- `plan` — неверное требование либо утверждённый план;
- `human` — корректный вариант требует решения человека.

Finding id имеет kebab-case формат и остаётся тем же при повторной проверке той же проблемы.
Менять id ради обхода лимита нельзя; исчезнувший finding не включается в новый вердикт.

Форма замечания ограничена, и границы жёсткие: `id` — kebab-case до 64 символов, уникальный
в пачке; `summary` — ОДНА строка 1..500 символов без переводов строки и управляющих символов;
замечаний 1..32. `summary` — ярлык замечания, а не разбор: доказательства, числа и цитаты
кладутся в файл этапа в `STATE_DIR`, на который ссылается причина. Нарушение любого правила —
отказ команды с кодом 2, и `stage-result` печатает в stderr НАЗВАННОЕ правило (какое поле,
какой замер, какой допуск). До появления этого сообщения скептик в одном прогоне 17 минут
не мог отчитаться из-за слишком длинного `summary`, угадывал причину пробными вызовами — и
терминальный исход узла закрыл случайный плейсхолдер из диагностического вызова.
Canonical verdict хранится в run capability record и immutable event, а не в свободных полях
pipeline. Старый `failed` без metadata остаётся совместимым для уже опубликованных prompts.

Agent/command node может объявить полный объект `onFailure` со всеми пятью владельцами.
При typed `failed` runtime выбирает этот переход; без `onFailure` либо для legacy failed
используется `on.failed`. В typed context производная проверенного hash-chain доступна как
`evidence.findings.open` и `evidence.findings.closed`: успешный повтор source-узла закрывает
его прежние findings, история при этом не переписывается.

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

`retry.productFailure` — повтор текущего узла до применения перехода `on.failed`/`onFailure`.
Поэтому комбинация `productFailure > 0` и rewind проверочного failed запрещена для новых
typed-переходов: исправить вход
проверяющего может только узел-цель возврата, а повтор до rewind снова увидит прежний план,
тесты или diff. Для автора/BUILD допустим `productFailure > 0`, если его `failed` не ведёт
на другой узел и повтор действительно способен исправить собственный результат.

## Prompt этапа

Хороший prompt-файл исполняемого узла immutable bundle отвечает на четыре вопроса:

1. что сделать;
2. откуда взять вход и куда записать артефакт;
3. какой project-specific командой проверить результат;
4. при каких условиях завершить `done`, `skipped` или `failed`.

Общий служебный блок движка поверх prompt замыкает scope описанием и критериями задачи,
явными исключениями и прямыми решениями человека. Профильный prompt не должен объявлять
план, разведку, отчёт или finding самостоятельным источником требований. Каждое изменение,
тест и блокирующий finding связываются с точным критерием; остальное записывается как
неблокирующий `outside scope / follow-up` и не ведёт к rewind.

Проверяющий узел, который может вернуть маршрут к автору, на первом проходе собирает полный
набор блокирующих замечаний. На повторном проходе он сначала проверяет
`evidence.findings.open`, сохраняет id той же проблемы и не добавляет блокеры о том, что
существовало уже при прошлом вердикте. Новый id в этой автоматической дуге фиксируется в
ledger, но вместо очередного rewind даёт human-resumable `no-progress`: даже возможную
регрессию после исправления сначала должен принять человек. Повтор того же `owner + finding
ids` после одного ремонта тоже даёт `no-progress`, даже если summary уточнён. Поэтому
возвращаемый автор должен включать `evidence` в `prompt.requiredContext` и исправлять открытый
набор, не расширяя матрицу проверок.

Из этого правила есть одно исключение, и профиль включает его сам. Замечание может нести
необязательный якорь (`--finding-anchor "id=путь"`), а вердикт — необязательный охват прохода
(`--reviewed "путь"`, до 64 путей). Новый id, чей якорь не значится ни в одном объявленном
охвате этой серии, движок считает первой встречей с артефактом, созданным во время ремонта, и
проводит обычный автоматический возврат вместо остановки. Prompt проверяющего узла, который
хочет такой автономии, обязан требовать обе метки: без `reviewed` отсев не включается вовсе,
а якорь на уже просмотренный путь оставляет прежнюю остановку. Формулировать в prompt честно —
объявлять просмотренным только то, что агент открывал: пропущенный файл нельзя будет назвать
новым, и маршрут встанет там, где мог бы доехать сам.

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

## Fanout

Fanout задаётся только в `node.fanout` immutable bundle. Runtime поддерживает
`single/1/forbid` и `parallel/N/{forbid|allow-single}` только для `state-only` agent-узлов.
`forbid` требует native capability `fanout` у выбранного runner. `allow-single` явно
деградирует к последовательному разбору независимых зон внутри того же run; это остаётся
одним terminal result и одним переходом route. Command-узел всегда single.

Параллельная запись в один workspace и параллельные замеры на одном shared-стенде запрещены:
server и engine отклоняют parallel при любой файловой политике кроме `state-only`. Максимум
исполнителей приходит из bundle, фактический fanout пишется движком в telemetry.

### Лимит времени этапа

Источник правды — **класс узла** (`policy.timeoutClass` в бандле маршрута), а не имя этапа:
длительность диктует роль узла, и одна схема должна вести себя одинаково у всех проектов.
Порядок разрешения:

1. класс узла → таблица дефолтов движка (`planning`/`standard`/`review`/`delivery`/`check` —
   1800 с, `test`/`build` — 3600 с, `diagnostic`/`browser` — 5400 с);
2. `profile_timeout_class <CLASS>` — если проекту нужны другие секунды для того же класса.

Bundle с неизвестным классом отклоняется server- и engine-валидаторами до запуска.
Shell-override по имени stage и fallback на старые маршруты отсутствуют.

Движок сам приписывает в конец промпта регламент: сколько минут у этапа всего и к какому
сроку зафиксировать результат через `stage-result`. Числа берутся из того же вызова, что и
фактический `timeout`, поэтому разойтись не могут. Агенту, убитому по таймауту, этап не
засчитывается целиком — правки в worktree остаются, но следующий заход о них не знает.

## Схема Cockpit

`profiles/<name>/graph.json` обязательна как явный capability/config marker. Cockpit не строит
fallback-схему, а topology, подписи, переходы и optional outcomes читает из опубликованного
immutable route catalog.

До публикации профиль оставляет `capabilities: []`. Правильный порядок активации:

1. проверить source definition, prompts, переходы и no-ship topology локальным тестом профиля;
2. опубликовать bundle во временный store и перечитать каждый immutable hash;
3. выполнить CAS-публикацию в live catalog;
4. отдельным последним действием включить `"route-v2"` в `graph.json`.

Генератора shell-маршрутов и синхронизации route arrays с UI-графом нет.

### Профиль, который задач не ведёт

Не каждый каталог в `profiles/` — конвейер. Профиль может существовать ради triage-конфигурации
кокпита (`PROFILE_CTX`, `PROFILE_TRIAGE_*`, пути репозиториев) и allow-list команд агенту в чате,
а задачи по проекту приходить прямым промптом без песочницы и этапов. Такой профиль заявляет это
полем `graph.json`:

```json
{ "capabilities": [], "launchable": false }
```

`factory-check` тогда не требует от него route-хуков, стенда и runner config, а печатает одну
строку «профиль задач не ведёт» и не портит общий код возврата. Поле нужно именно проверке:
движок его не читает, и `factory start` откажет fail-closed сам — по отсутствующей capability.
Отсюда запрет: `launchable: false` вместе с `"route-v2"` в `capabilities` — ошибка проверки
(код 1). Иначе прогон бы шёл, а route и стенд оставались непроверенными; это хуже любого из
двух состояний по отдельности.

Появилось поле не для красоты вывода: пока его не было, `factory-check` без аргументов не мог
вернуть ноль ни при каком состоянии профилей — «ЕСТЬ ПРОБЛЕМЫ» перестало отличать сломанный
конвейер от профиля, у которого конвейера нет по замыслу, и проверку перестали читать. Вернуть
профилю запуск снятием этого поля нельзя: это работа «нового проекта»
([NEW-PROJECT.md](NEW-PROJECT.md)) — девять хуков, опубликованный бандл и решение про стенд.

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

На рабочем хосте перед первым запуском задачи:

```bash
RUN_HOST_PREFLIGHT=1 engine/bin/factory-check <name> --host-preflight
```

Проверки должны подтвердить:

- либо `launchable: false` — профиль честно не ведёт задач, проверки запуска пропущены;
- capability и обязательные workspace/stand hooks;
- canonical runner config;
- форму хоста стенда (`PROFILE_SERVICE_HOST`);
- model policy и coverage;
- metadata-only readiness рабочего хоста.

Schema, prompts, переходы и no-ship topology проверяет source-тест маршрутов профиля до
live-публикации.
