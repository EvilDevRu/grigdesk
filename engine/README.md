# Factory — движок конвейера задач

Автоматизирует путь задачи **от тикета до Pull Request**: поднимает изолированный стенд, проводит
работу через цепочку агентов (план → тесты → код → ревью → проверки → браузер), а человек участвует
только на **двух воротах** — утвердить план и принять результат. Всё остальное едет само.

Движок **не привязан к проекту**. Вся специфика (стек, база, как поднять стенд, чем тестировать)
живёт в локальном каталоге **профиля** `profiles/<name>/`: `profile.sh`, конфигурация и
проектные скрипты стенда. Корневой `/profiles/` целиком игнорируется Git: это конфигурация
конкретной машины и проектов, а не часть движка.
Новый проект = новый профиль; движок при этом не меняется.

**Документация:** [NEW-PROJECT.md](../docs/engine/NEW-PROJECT.md) — завести проект ·
[PROFILE-CONTRACT.md](../docs/engine/PROFILE-CONTRACT.md) — что профиль обязан дать движку ·
[ENGINE.md](../docs/engine/ENGINE.md) — как менять сам движок · [CLAUDE.md](CLAUDE.md) — правила для агента.

---

## Философия

Взято из идеи «AI developer workflows»: **код держит порядок, агенты работают короткими вспышками.**
Оркестратор — это не один большой «агент-дирижёр» (он хрупок: живёт часами, ждёт, теряет фоновые задачи),
а обычный **bash-конечный автомат**. Каждый этап — один блокирующий вызов выбранного runner-а, который делает
ровно этот этап синхронно, ставит статус и завершается. Между этапами:

- **детерминированные проверки кодом** (тесты зелёные? хеши тестов целы? diff не вырос?) — пропуск на
  следующий этап даёт не слово агента, а проверка;
- **ворота человека** — bash ждёт решения, читая файл-реестр (дёшево, без висящего агента);
- **resume** — атомарен по этапам: перезапустил → продолжил с точного места, готовое не переделывается.

Автономности у самого движка нет намеренно: после перезагрузки конвейеры не продолжаются сами.
Запуск и resume — вручную из GrigDesk или CLI, когда оператор за машиной.

---

## Как это выглядит для человека

1. Открыл задачу в трекере → «Запустить фабрику».
2. Поднимается стенд, разведка выбирает маршрут (feature / debug / trivial).
3. Разведка выбирает маршрут; feature-план строится одним read-only fanout: анализ кода,
   независимая критика и тест-дизайн сводятся координатором в один документ.
4. **🚦 Ворота плана** — читаешь план в GrigDesk, «Утвердить» или «Отклонить с замечаниями».
5. Тесты пишутся *до* кода (и обязаны падать), код строится до зелёных тестов. Trusted VERIFY
   без модели сверяет frozen-хеши и запускает опубликованные профилем проверки проекта;
   затем семантический ревьюер и при необходимости браузер проверяют результат. Трассировка
   остаётся в debug-маршруте, где она действительно нужна.
6. **🚦 Ворота приёмки** — смотришь результат и скриншоты, «Принять» или «Отклонить».
7. Принял → коммит, PR, комментарий в трекер, закрытие задачи.
   Стенд движок не сносит: это кнопка «⏻ Снести стенд» на карточке — после отгрузки песочница
   часто ещё нужна. Демо-видео с озвучкой конвейер не ждёт: оно снимается отдельно, кнопкой
   плагина «Демо» в GrigDesk, пока стенд жив.

Каждый шаг виден в GrigDesk диаграммой конвейера с подсветкой активного узла.

---

## Системные требования

Сам движок — bash плюс Python из коробки: **пакетных зависимостей нет**, ни `pip install`, ни
`npm install` для фабрики делать не нужно.

| Что | Версия | Зачем движку |
|---|---|---|
| Linux | — | GNU-утилиты `timeout`, `flock`, `nohup` |
| bash | ≥ 4.0 | `mapfile` при разборе профилей |
| python3 | ≥ 3.8 | проверки профиля и резервный диагностический dashboard |
| git | — | worktree, diff и состояние веток |
| `claude` / `codex` / `kimi` | совместимая с runner fixture версия | исполнители этапов; нужен CLI выбранной цепочки и его локальная авторизация |
| DeepSeek Harness | exact `0.1.5-rc.2` | опциональный ACP-исполнитель; ставится pinned-скриптом, нужен `DEEPSEEK_API_KEY` |

Три утилиты держат несущие инварианты, и заменять их нечем: `flock` — «один демон на задачу»,
`timeout` — потолок этапа, `nohup` — уход конвейера в фон. Все из базовой поставки дистрибутива.

Резервный Python-dashboard написан на stdlib (`http.server`, `subprocess`, `json`) — ни venv,
ни веб-фреймворка. Основной интерфейс — GrigDesk на `:8140`; `bin/dashboard` сохранён как
диагностический/совместимый просмотр состояния, а не как второй источник управления.
Проектные панели и интеграции резервного dashboard принадлежат локальному профилю: движок
не содержит их путей, credential policy или дополнительных зависимостей.

**По необходимости:**

- **systemd (user)** — GrigDesk работает как user-service. Запуск фабрики *из сервиса* идёт
  через отдельный scope: иначе рестарт пульта убьёт демона вместе с агентом
  ([ENGINE.md](../docs/engine/ENGINE.md)).
- **Стек проекта требует профиль, а не движок.** Движок не знает ни одного проекта, поэтому и
  требований к стеку не предъявляет. Любые дополнительные CLI и сервисы объявляет локальный
  профиль, а их наличие проверяет его preflight.

---

## Запуск

```bash
export FACTORY_STATE=$HOME/.factory/state          # где живут реестры задач (по умолчанию)

bin/factory <TASK> start  --profile <PROFILE> --ticket "текст задачи"
bin/factory <TASK> resume --profile <PROFILE>  # продолжить после ворот/смерти/ребута
bin/factory list                               # активные задачи

bin/dashboard <PROFILE> <PORT>                  # резервная диагностика, не основной UI
```

- `claude` и `codex` — самостоятельные CLI; авторизация и каталоги проверяются host preflight.
- Демонизируется (nohup) — работа в фоне. **Один демон на задачу** (flock + запись PID).

### Выбор ИИ без GrigDesk

Каждый профиль обязан иметь `profiles/<name>/runners.env`. Без него запуск останавливается
до model call. Конфиг задаётся явно через CLI или вручную по контракту и включает coverage gate:

```bash
bin/factory profile <PROFILE> runner set claude --failover codex

# family — долгоживущая настройка; latest берёт новую версию из локального каталога
bin/factory profile <PROFILE> model set DEFAULT claude family=opus version=latest effort=max
bin/factory profile <PROFILE> model set DEFAULT codex family=sol version=latest effort=xhigh

# preflight читает metadata/версии/auth, но не посылает model prompt
RUN_HOST_PREFLIGHT=1 bin/factory-check <PROFILE> --host-preflight

bin/factory <TASK> runner show
bin/factory <TASK> runner set REVIEW codex --failover claude
bin/factory <TASK> runner switch REVIEW codex
```

Наличие `runners.env` само по себе не разрешает model call: после каждой правки routing/model
policy нужен свежий host preflight. Неизвестная ошибка, timeout, sandbox denial, неверная
модель/effort и `failed` агента никогда не переключают provider. Автоматический переход после
старта разрешён только для доказанного `limited`; до старта — для кандидата, который preflight
пометил недоступным или несовместимым.

### Диагностические логи

Подробное логирование по умолчанию выключено и не влияет на выбор ИИ:

```bash
# общий уровень
bin/factory settings debug set decisions

# только один проект
bin/factory profile <PROFILE> debug set errors

# временно одна задача; без --for действует два часа
bin/factory <TASK> debug set verbose --for 2h
bin/factory <TASK> debug show
bin/factory <TASK> debug clear

# явно выключить для всей фабрики
bin/factory settings debug set off
```

Уровни: `off`, `errors`, `decisions`, `verbose`. Глобальный уровень — верхний предел:
`off` выключает debug trace даже при настройке задачи или профиля. Внутри этого предела
приоритет более строгих значений — `задача → проект → глобальная настройка`.
Trace лежит рядом с run в
`state/logs/runs/t<TASK>/<STAGE>/<run-id>/debug.trace.jsonl`. В него не попадают prompt,
credentials, environment и status/control tokens. Настройки хранятся отдельно от
`runners.env`, поэтому включение debug не сбрасывает coverage.

Тот же глобальный переключатель доступен в GrigDesk: «Настройки → Запуски →
Диагностическое логирование». UI вызывает engine writer через API и не хранит
собственную копию настройки.

---

## Структура

```
bin/
  factory              CLI: разбор аргументов, демонизация, загрузка профиля, запуск конвейера
  dashboard            резервный Python-интерфейс для диагностики/совместимости
lib/
  core.sh              ЯДРО: provider-neutral orchestration и вход в dispatcher
  multi-runner.sh      routing, model resolution, failover, telemetry и coverage gate
  runners/             независимые модули CLI (Claude, Codex, Kimi, DeepSeek, будущие providers —
                       добавление по ../docs/engine/ADDING-RUNNER.md)
  dispatcher.sh        белый список причин переключения + circuit breaker
  run-state.sh         run-id/epoch/capability CAS terminal status
  runner-cli.sh        project/stage/task routing и runtime switch
  debug-settings.sh    global/profile/task debug settings, precedence и expiry
  debug-log.sh         typed trace, runtime on/off, redaction, size limit и TTL
  pipeline-set.sh      ограниченный writer вторичной проекции; topology/lifecycle ему недоступны
  dashboard.py         реализация резервного интерфейса и эталон части логики графа
profiles/                   локальный каталог, целиком вне Git
  <name>/
    profile.sh         project context, workspace/stand hooks и command policy
    runners.env        обязательная runner/model policy проекта
    dashboard.env      проектные пути/контейнеры/трекер для дашборда
    graph.json         capability/config marker профиля
    routes/            source definitions, immutable prompts и publisher каталога
    stand scripts…     project-specific health/lifecycle, если их допускает workspace mode
../docs/engine/         документация и план развития движка
../tests/engine/        unit, contract, integration, race и проверки профилей
```

**Данные (вне репозитория):** immutable attempt ledger в
`~/.factory/control/protocol-v2/tasks/` — источник истины маршрута и lifecycle;
`~/.factory/state/tNNNN.pipeline` — только вторичная проекция для GrigDesk. Рядом лежат
`logs/`, `archive/` и `shots/` (скриншоты браузера).

---

## Добавить новый проект

Движок не знает ни одного проекта: route source, prompts и контракт стенда живут в профиле.

Профиль создаётся вручную по [NEW-PROJECT.md](../docs/engine/NEW-PROJECT.md). Старые
генераторы удалены: они создавали shell-массивы этапов и profile prompts, которые единый
route runtime не исполняет.

Профиль состоит из:

- **`profiles/<имя>/profile.sh`** — project context, workspace/stand hooks и доступ агента
  (`PROFILE_AGENT_DIRS` / `PROFILE_AGENT_ALLOW`);
- **`profiles/<имя>/runners.env`** — обязательные primary/failover и family policy моделей;
- **`profiles/<имя>/dashboard.env`** — пути, контейнер стенда, трекер и базовый URL задач;
- **`profiles/<имя>/graph.json`** — явный capability/config marker;
- **`profiles/<имя>/routes/`** — source definitions, prompts, тест и publisher immutable
  route catalog.

Порядок проверки и активации:

```bash
# сначала локальный source-тест профиля и публикация во временный store
bin/factory-check <имя> --quick
RUN_HOST_PREFLIGHT=1 bin/factory-check <имя> --host-preflight
# live catalog публикуется CAS; capability включается отдельным последним действием
bin/factory <TASK> start --profile <имя> --ticket "…"
```

Подробно, с вопросами, которые надо задать до написания профиля:
**[NEW-PROJECT.md](../docs/engine/NEW-PROJECT.md)**.

## Устойчивость (что сделано, чтобы не разваливалось)

- **GrigDesk** — основной UI под systemd; движок запускается в отдельном scope и не привязан
  к жизненному циклу веб-сервера. Python-dashboard остаётся ручной диагностикой.
- **Наблюдатель** отличает «завис» (журналы агента молчат >15 мин) от «ждёт человека на воротах».
- **Санити графа**: один активный узел (инвариант линейности); пропущенный обязательный этап — красная
  аномалия, а не тихий пропуск; приёмка при недоделанном хвосте — «преждевременно», а не «готово».
- **Возврат задаёт маршрут**: gate commit хранит exact reset-set в immutable журнале,
  а движок проецирует его в GrigDesk по `runKey` закреплённой machine. Фиксированных
  `--replan`/`--reject-accept` и скрытого списка этапов больше нет.

---

## Локальные профили

Фактический список подключённых проектов намеренно не публикуется в документации движка.
Профили находятся в игнорируемом Git каталоге `profiles/<name>/` и выбирают один из
контрактных режимов: изолированный workspace со стендом задачи либо shared workspace с
внешним стендом. Требования к обоим режимам описаны в
[PROFILE-CONTRACT.md](../docs/engine/PROFILE-CONTRACT.md).
