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

Допустимые семейства объявляет сам раннер (`runner_<provider>_family_alias`), потому что без
каталога семейство уходит в CLI как имя модели: у `claude` это `opus|fable|sonnet|haiku`,
у `codex` семейных алиасов нет — там семейство обязано прийти из каталога.

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
| `profile_stage_timeout <STAGE>` | жёсткий timeout в секундах; действует только там, где узел не объявил `policy.timeoutClass` |
| `profile_timeout_class <CLASS>` | переопределить секунды класса времени из бандла маршрута |
| `profile_stage_fanout <STAGE>` | `AUTO min-max` или фиксированные зоны |
| `profile_stage_readonly <STAGE>` | объявить проверочный этап read-only |
| `profile_source_roots <TASK>` | вывести по одному абсолютному git root для точного guard |
| `profile_sensitive_files <TASK>` | перечислить ignored-файлы, чьё содержимое тоже контролируется по hash |

`PROFILE_ARCHIVE_ON_FINISH=1` архивирует карточку только после успешного основного маршрута
и терминальных `SHIP → RETRO`. Незавершённый хвост остаётся активным и получает
`STALLED_HUMAN=1`.

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

Разрешение сверяется по префиксу строки, поэтому на проверочных этапах движок запрещает
запускатели чужих команд (`timeout`, `env`, `xargs`, `nohup`, `setsid`, `stdbuf`, `nice`,
`sudo`, `sh -c`, `bash -c`): иначе `timeout git commit …` проходит мимо запрета на коммит.
Запрет действует и на скрипты профиля — если проектной команде нужна обёртка, заворачивай её
внутрь своего скрипта и разрешай уже сам скрипт. Так же решается и обратная задача: команду
с обязательными переменными окружения (`E2E_BASE_URL=… npx playwright test`) одним префиксом
не выразить, поэтому её место — исполняемый файл профиля в `PROFILE_AGENT_ALLOW`. Иначе
проверяющий этап не найдёт разрешённой формы запуска e2e и примет падение спек на веру,
хотя на живом стенде они зелёные.

Read-only этап v1 защищается двумя слоями:

1. deny правил для очевидных writer/auto-fix команд;
2. точным сравнением `HEAD`, worktree diff, index diff, содержимого tracked/untracked,
   symlink targets и объявленных sensitive ignored-файлов до и после этапа.

При нарушении этап останавливается с `STALLED_HUMAN=1`. Движок ничего не откатывает:
обычный readonly guard не владеет изменением и не может безопасно отличить запись агента
от параллельной правки человека. `profile_dirty_files`, `profile_revert_files` и
`FACTORY_AUTOREVERT` больше не являются механизмом защиты.

Это compatibility-backstop, а не host-level sandbox. Политика route v2 `state-only` может
считаться обеспеченной только runner-ом, который физически не монтирует source roots на
запись; до этого v2-cutover для такого узла запрещён.

## Временная инструментация

Для `trace → verify` используется host-controlled API
`engine/lib/instrumentation-transaction.sh`:

```text
instrumentation_tx_begin TASK TXID SCOPE_FILE FACTORY-TRACE:tTASK GIT_ROOT...
instrumentation_tx_checkpoint TASK TXID
instrumentation_tx_cleanup TASK TXID
```

До вызова host обязан выдать отдельный linked worktree только одной попытке и установить
`FACTORY_INSTRUMENTATION_ISOLATION=exclusive-worktree-v1`. Библиотека механически
отклоняет primary checkout; реестр аренды остаётся в trusted control plane и не передаётся
provider-процессу.

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

### `PROFILE_VOLATILE_PATHS` — что пишет само приложение

В чувствительное множество снимка попадают ВСЕ ignored-файлы обоих корней: именно там
правку проще всего спрятать (`.env`, `vendor`, `node_modules`). Но рядом крутится стенд,
и узел вроде `TRACE` ради живого прогона и существует — приложение пишет логи, кэши и
трассы само, без участия агента. Сторожу это неотличимо от записи агента: файл был
другой — значит кто-то менял. Поэтому приёмка может встать fail-closed на файлах
`storage/debugbar`, `storage/logs` и артефактах Playwright, даже если исходников среди
них нет.

Какие пути изменчивы, знает только проект, поэтому список объявляет профиль — строка
глобов через пробел, относительно КАЖДОГО корня:

```sh
PROFILE_VOLATILE_PATHS="storage/debugbar/* storage/logs/* storage/framework/* \
  bootstrap/cache/* e2e/traces/* e2e/.auth/* test-results/* playwright-report/*"
```

Глоб сверяется целиком с путём относительно корня (`*` перекрывает и `/`, поэтому
`storage/logs/*` закрывает вложенные каталоги). Разделитель — пробел, поэтому путей с
пробелами в списке быть не может. Абсолютные пути отклоняются (код 78). Совпавшее
не попадает в чувствительное множество вовсе — ни в baseline, ни в checkpoint.
Объявленный scope этапа сильнее: файл из scope остаётся под наблюдением, даже если
подходит под глоб.

Список замораживается в транзакции (`volatile.list` рядом с `roots.list`) при `begin`.
Снимки одной транзакции обязаны сравниваться байт в байт, а профиль между заходами
могли и поправить — иначе перезапуск демона посреди транзакции дал бы ложное нарушение.
Транзакции, начатые до появления файла, читаются как «изменчивых путей нет».

Чем шире список, тем больше слепая зона: объявляй каталоги артефактов, а не корни.

### `PROFILE_SERVICE_HOST` — под каким именем открывать стенд

Адрес стенда движок собирает сам: `http://<host>:<порт>` уезжает агенту в
`services.frontendUrl` и `services.apiUrl`. Порт свой у каждой песочницы и известен
движку, а вот имя хоста — слово проекта:

```sh
PROFILE_SERVICE_HOST="localhost"   # умолчание: 127.0.0.1
```

Разница не косметическая. Приложение вправе решать «локальный запуск или прод» по
`window.location.hostname`, и тогда петлевой адрес переключает фронт в продовый режим:
другой эндпоинт авторизации, другой путь логина, поведение, которого в песочнице нет.
Приёмка t8165 открыла стенд по `127.0.0.1`, фронт (`isLocal` по `VITE_LOCAL_DOMAIN=localhost`)
счёл себя продом, получил 401 на `/api/validate-user-auth` и ушёл на прод-путь
`/tools/login`, которого в сборке песочницы нет; гвард роутера дописывал `?redirect=` и
перезагружал страницу заново — 93 витка, после чего браузер перестал отвечать, а узел
`browser` провисел все 90 минут, не проверив ни одного сценария.

Значение — голое имя хоста или адрес: без схемы, порта и слэшей (их добавляет движок).
Форму проверяет `factory-check`, чтобы ошибка не всплыла на живом прогоне.

## Route v2: capability и хуки

Профиль, готовый к immutable-протоколу route v2 (`factory-v2`), обязан:

1. заявить `"route-v2"` в `capabilities` своего `graph.json` — без этого launcher
   отказывает профилю до каких-либо действий;
2. реализовать в `profile.sh` семь v2-хуков (движок валидирует форму значений
   fail-closed и не содержит ни одного проектного пути):

| Хук | Возвращает |
|---|---|
| `profile_v2_backend_source` | абсолютный путь основного backend-репозитория |
| `profile_v2_frontend_source` | абсолютный путь основного frontend-репозитория |
| `profile_v2_backend_worktree TASK` | путь backend-worktree поколения v2 (может ещё не существовать — его создаст `up.sh`) |
| `profile_v2_frontend_worktree TASK` | путь frontend-worktree поколения v2 |
| `profile_v2_source_branch TASK` | имя ветки задачи, одна на оба репозитория |
| `profile_v2_container TASK` | имя контейнера/сервиса приложения (уходит в typed context) |
| `profile_v2_sandbox_alive TASK` | код 0, если стек песочницы жив (чем проверять — знание профиля: docker, systemd, …) |

Песочницу поколения v2 поднимает `profiles/<имя>/up.sh <TASK>` — тот же контрактный
скрипт, что у v1; launcher зовёт его с `FACTORY_SANDBOX_GENERATION=v2`,
`FACTORY_REQUIRE_NEW_SANDBOX=1` и base-ref переменными. `up.sh` обязан записать
`STATE_DIR/t<TASK>.env` с ключами `TASK`, `GENERATION=v2`, `BE_WT`, `FE_WT`,
`BE_BRANCH`, `FE_BRANCH` (обе равны `profile_v2_source_branch`), `SB_K`,
`API_PORT`, `FE_PORT` — движок сверяет каждый с ожиданиями из хуков и отказывает
при расхождении. Worktree v2 не имеют права совпадать с legacy worktree-tN и
никогда не откатываются на старую песочницу.

Остальные `STATE_DIR/t<TASK>.*` — файлы движка, профиль их не создаёт и не чистит:
`.pipeline`, `.stage`, журналы этапов и черновики хода `t<TASK>.<этап>.checkpoint.md`
(их время жизни движок ведёт сам — см. [ENGINE.md](ENGINE.md)). Снос песочницы в `down.sh`
должен убирать только то, что создал сам, а не подметать маску `t<TASK>.*`.

Typed context принимает ПРОИЗВОЛЬНЫЙ список репозиториев профиля:
`factory-context-v2 --repo имя:worktree:source` (повторяемый). В контексте они
лежат под своими именами — `workspace.<имя>.path`/`.sourcePath`, а `workspace.repos`
перечисляет их в порядке объявления. Однорепозиторному профилю достаточно одного
`--repo`; двухрепозиторные флаги `--backend-*`/`--frontend-*` остаются
совместимым сахаром и дают привычные `workspace.backend`/`workspace.frontend`.
Промпты бандла обращаются к репозиториям по именам своего профиля.

Файловая политика узла дополнена явным разрешением браузера:
`policy.browser: forbid|allow` (умолчание `forbid`). Разрешение независимо от
`policy.filesystem` — узел приёмки бывает `state-only`, но браузер ему нужен, а
разведке и планированию он не положен даже при доступной записи. При `forbid`
движок кладёт `mcp__playwright*` в deny-правила запуска: браузер физически
недоступен агенту, а не «не рекомендован промптом».

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

`profile_stage_budget` ограничивает глубину, класс времени — длительность процесса.
Фактическая длительность и fanout пишутся движком в telemetry.

### Лимит времени этапа

Источник правды — **класс узла** (`policy.timeoutClass` в бандле маршрута), а не имя этапа:
длительность диктует роль узла, и одна схема должна вести себя одинаково у всех проектов.
Порядок разрешения в `_stage_timeout`:

1. класс узла → таблица дефолтов движка (`planning`/`standard`/`review`/`delivery`/`check` —
   1800 с, `test`/`build` — 3600 с, `diagnostic`/`browser` — 5400 с);
2. `profile_timeout_class <CLASS>` — если проекту нужны другие секунды для того же класса;
3. `profile_stage_timeout <STAGE>` — только для узлов без класса и маршрутов v1;
4. `NODE_TIMEOUT` (1800 с, переопределяется `FACTORY_STAGE_TIMEOUT`).

Класс, которого движок не знает, не роняет этап: берётся `NODE_TIMEOUT`, а несовпадение
пишется в журнал этапов строкой `ЛИМИТ: неизвестный timeoutClass=…`.

Движок сам приписывает в конец промпта регламент: сколько минут у этапа всего и к какому
сроку зафиксировать результат через `stage-result`. Числа берутся из того же вызова, что и
фактический `timeout`, поэтому разойтись не могут. Агенту, убитому по таймауту, этап не
засчитывается целиком — правки в worktree остаются, но следующий заход о них не знает.

## Схема Cockpit

`profiles/<name>/graph.json` обязательна: Cockpit не строит fallback-схему.

Схема содержит:

- узлы и координаты;
- `capabilities` — явные внепоточные возможности профиля, например `["demo"]`;
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

На рабочем хосте перед первым запуском задачи:

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
