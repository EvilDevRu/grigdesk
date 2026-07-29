# Новый проект в Factory

Новый проект добавляется профилем, а не условием в движке.

## 1. Собрать требования

До генерации профиля выяснить:

1. что является задачей и откуда берётся ticket;
2. чем доказать результат: тестом, метрикой, браузером, ручной приёмкой;
3. как изолируется стенд и можно ли запускать задачи параллельно;
4. какие команды/данные/ресурсы запрещены агенту;
5. где обязательны человеческие ворота;
6. какой ИИ primary и какой failover для этого проекта;
7. какие семейства моделей нужны сильным и дешёвым этапам.

Не использовать глобальный default: один проект может быть Claude-first, другой Codex-first.

## 2. Сгенерировать каркас

```bash
engine/bin/factory-new <name> /absolute/project/root
```

Команда создаёт:

```text
profiles/<name>/
  profile.sh
  runners.env
  dashboard.env
  graph.json
```

Сначала исправить все `TODO`, затем запускать проверки.

## 3. Выбрать runner policy

Скелет создаётся Claude → Codex. Если проект Codex-first:

```bash
engine/bin/factory profile <name> runner set codex --failover claude
```

Настроить семейства:

```bash
engine/bin/factory profile <name> model set DEFAULT codex \
  family=sol version=latest effort=xhigh
engine/bin/factory profile <name> model set DEFAULT claude \
  family=opus version=latest effort=max
engine/bin/factory profile <name> model set SCOUT codex \
  family=terra version=latest effort=high
engine/bin/factory profile <name> model set SCOUT claude \
  family=sonnet version=latest effort=high
```

Хранить номер конкретного релиза нужно только при осознанном pin. Для автоматического
обновления внутри линии использовать `family + version=latest`.

## 4. Описать маршруты

Маршрут — последовательность project stages:

```bash
PROFILE_ROUTE_STAGES_dev=(SCOUT PLAN GATE_PLAN TESTS BUILD REVIEW GATE_ACCEPT)
PROFILE_ROUTE_STAGES_quick=(SCOUT BUILD REVIEW GATE_ACCEPT)
```

Правила:

- `GATE_*` — ожидание человека;
- SCOUT публикует `ROUTE` через `stage-progress`;
- route должен существовать в профиле;
- SHIP/RETRO выполняет хвост движка, если проект использует эти этапы;
- DEMO запускается отдельной командой и не входит в обычный route.

Не создавать два маршрута, если они не отличаются существенной гарантией.

## 5. Написать prompts

`profile_stage_prompt <TASK> <STAGE>` должен содержать:

- цель одного этапа;
- входные артефакты;
- выходной артефакт;
- команды проверки;
- условия `done`, `skipped`, `failed`.

Terminal команда добавляется движком:

```text
stage-result ... done
stage-result ... skipped "причина"
stage-result ... failed "причина"
```

Для route/internal nodes использовать добавленную `stage-progress`:

```text
ROUTE dev ROUTE_BY scout
PLANS done SKEPTIC done VALIDATE done TRANSLATOR done
```

Не писать fixed status files и не давать агенту общий pipeline writer.

## 6. Настроить доступы

```bash
PROFILE_AGENT_CWD="/path/to/project"
PROFILE_AGENT_DIRS="/path/to/project-worktrees /path/to/second-repo"
PROFILE_AGENT_ALLOW=("Bash(docker exec project-app:*)")
PROFILE_AGENT_DENY=("Bash(project-destructive-command:*)")
```

Пути и команды — разные permission channels. Разрешение Write не разрешает Bash и наоборот.

Для worktree задачи:

```bash
profile_agent_cwd() {
  local worktree="/path/to/worktrees/t${1}"
  [[ -d "$worktree" ]] && printf '%s\n' "$worktree"
}
```

## 7. Защитить проверочные этапы

```bash
profile_stage_readonly() {
  case "$1" in
    REVIEW|LINT|BROWSER) printf '1\n' ;;
    *) printf '\n' ;;
  esac
}

profile_dirty_files() {
  git -C "/path/to/worktrees/t${1}" status --porcelain |
    awk '{print "APP:" $NF}'
}
```

Deny правила убирают частые auto-fix команды, а diff guard ловит остальные записи.
Движок не откатывает пользовательские файлы без `FACTORY_AUTOREVERT=1`.

## 8. Добавить budget/fanout

```bash
profile_stage_budget() {
  case "$1" in
    SCOUT) printf '8\n' ;;
    BUILD) printf '20\n' ;;
    *) printf '\n' ;;
  esac
}

profile_stage_timeout() {
  case "$1" in
    BUILD) printf '3600\n' ;;
    *) printf '\n' ;;
  esac
}

profile_stage_fanout() {
  case "$1" in
    SCOUT)
      printf '%s\n' 'AUTO 3-8' 'Делить по реально затронутым подсистемам.'
      ;;
    *) printf '\n' ;;
  esac
}
```

Fanout применять для независимого чтения/анализа. Не применять для параллельной записи в один
worktree и замеров на общем стенде.

## 9. Реализовать стенд

```bash
profile_sandbox_up()     { ...; }
profile_sandbox_down()   { ...; }
profile_sandbox_exists() { ...; }
```

Скрипты хранить рядом в `profiles/<name>/`, а `profile.sh` оставлять тонким adapter-ом.

Если Cockpit распределяет несколько стендов:

```bash
profile_slots() {
  printf '%s\n' 'RANGE 0 5'
  printf '%s\n' 'USED 2 t1234 task'
}
```

Источник занятости должен совпадать с источником, который использует sandbox up/down.

## 10. Довести UI graph

`factory-new` создаёт graph из routes. Вручную проверить:

- подписи и координаты;
- route edges;
- возвраты review/test → build;
- `keys`;
- `optional`.

После правки маршрутов:

```bash
engine/bin/factory-graph-new <name> --force
python3 tests/engine/routes-sync.py <name>
```

Без graph Cockpit профиль не показывает.

## 11. Offline приёмка

```bash
engine/bin/factory-check <name> --quick
tests/run-all.sh
```

На этом этапе Cockpit и модели не запускаются.

Проверить вручную, что:

- `profiles/<name>/runners.env` валиден;
- primary/failover соответствуют проекту;
- сильные и дешёвые stages имеют policy обоих provider-ов;
- stage prompts используют result/progress v2;
- graph совпадает с routes;
- readonly/diff guard настроены;
- нет project-specific кода в `engine/lib`.

## 12. Host preflight

После offline suite:

```bash
RUN_HOST_PREFLIGHT=1 engine/bin/factory-check <name> --host-preflight
```

Это metadata-only проверка CLI/catalog/capabilities. Она не отправляет prompt.

## 13. Первый рабочий canary

Canary выполняется отдельно, когда разрешён запуск:

```bash
engine/bin/factory 1 start --profile <name> --ticket "маленькая обратимая задача"
```

Проверить в состоянии/UI:

- отображение project chain;
- фактический provider/model attempt;
- переход stage status;
- ручной task override;
- контролируемый failover на искусственно классифицированной provider error;
- блокировку failover на task/test/policy error;
- очистку task override и debug после проверки.
