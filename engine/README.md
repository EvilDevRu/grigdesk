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
Запуск и resume — вручную из Cockpit или CLI, когда оператор за машиной.

---

## Как это выглядит для человека

1. Открыл задачу в трекере → «Запустить фабрику».
2. Поднимается стенд, разведка выбирает маршрут (feature / debug / trivial).
3. Агенты планируют (разведка → конкурирующие планы → скептик ломает → переводчик пишет по-человечески).
4. **🚦 Ворота плана** — читаешь план в Cockpit, «Утвердить» или «Отклонить с замечаниями».
5. Тесты пишутся *до* кода (и обязаны падать), код строится до зелёных тестов, ревьюер ищет дефекты,
   trace-verify доказывает работу логами, линтеры и браузер проверяют.
6. **🚦 Ворота приёмки** — смотришь результат и скриншоты, «Принять» или «Отклонить».
7. Принял → коммит, PR, комментарий в трекер, закрытие задачи, ретро (уроки — с твоего согласия).
   Стенд движок не сносит: это кнопка «⏻ Снести стенд» на карточке — после отгрузки песочница
   часто ещё нужна. Демо-видео с озвучкой конвейер не ждёт: оно снимается отдельно, кнопкой
   плагина «Демо» в кокпите, пока стенд жив.

Каждый шаг виден в Cockpit диаграммой конвейера с подсветкой активного узла.

---

## Системные требования

Сам движок — bash плюс Python из коробки: **пакетных зависимостей нет**, ни `pip install`, ни
`npm install` для фабрики делать не нужно.

| Что | Версия | Зачем движку |
|---|---|---|
| Linux | — | GNU-утилиты `timeout`, `flock`, `nohup`. Обкатано на Linux Mint 21.3 (база Ubuntu 22.04), ядро 6.8 |
| bash | ≥ 4.0 | `mapfile` при разборе профилей; в работе — 5.1 |
| python3 | ≥ 3.8 | проверки профиля, `factory-graph-new` и резервный диагностический dashboard; в работе — 3.10 |
| git | — | worktree, diff и состояние веток |
| `claude` / `codex` | совместимая с runner fixture версия | исполнители этапов; нужен CLI выбранной цепочки и его локальная авторизация |

Три утилиты держат несущие инварианты, и заменять их нечем: `flock` — «один демон на задачу»,
`timeout` — потолок этапа, `nohup` — уход конвейера в фон. Все из базовой поставки дистрибутива.

Резервный Python-dashboard написан на stdlib (`http.server`, `subprocess`, `json`) — ни venv,
ни веб-фреймворка. Основной интерфейс — Cockpit на `:8140`; `bin/dashboard` сохранён как
диагностический/совместимый просмотр состояния, а не как второй источник управления.
Его arsenkin-панель таймера вызывает `b24-timer.mjs`, который переиспользует Cockpit
`B24Client` и `server/.state/b24-creds.json`. Для fallback-dashboard выделен отдельный cookie
jar; внешний B24-checkout не требуется.

**По необходимости:**

- **systemd (user)** — Cockpit работает как user-service. Запуск фабрики *из сервиса* идёт
  через отдельный scope: иначе рестарт пульта убьёт демона вместе с агентом
  ([ENGINE.md](../docs/engine/ENGINE.md)).
- **Стек проекта требует профиль, а не движок.** Движок не знает ни одного проекта, поэтому и
  требований к стеку не предъявляет: `docker` с compose, `node`/`npm`, `gh`, `curl`, `ffmpeg` нужны
  ровно настолько, насколько их зовут хуки стенда и этапы конкретного профиля. Например, `arsenkin`
  просит docker, node/npm, `gh` (PR) и `ffmpeg` (демо-видео) — у другого профиля набор свой.

---

## Запуск

```bash
export FACTORY_STATE=$HOME/.factory/state          # где живут реестры задач (по умолчанию)

bin/factory <TASK> start  --profile arsenkin --ticket "текст задачи"
bin/factory <TASK> resume --profile arsenkin       # продолжить после ворот/смерти/ребута
bin/factory list                                    # активные задачи

bin/dashboard arsenkin 8070                          # резервная диагностика, не основной UI
```

- `claude` и `codex` — самостоятельные CLI; авторизация и каталоги проверяются host preflight.
- Демонизируется (nohup) — работа в фоне. **Один демон на задачу** (flock + запись PID).

### Выбор ИИ без Cockpit

Каждый профиль обязан иметь `profiles/<name>/runners.env`. Без него запуск останавливается
до model call. Конфиг создаётся `factory-new` или явно через CLI и включает coverage gate:

```bash
bin/factory profile arsenkin runner set claude --failover codex
bin/factory profile rdesigner runner set codex --failover claude

# family — долгоживущая настройка; latest берёт новую версию из локального каталога
bin/factory profile arsenkin model set DEFAULT claude family=opus version=latest effort=max
bin/factory profile arsenkin model set DEFAULT codex family=sol version=latest effort=xhigh

# preflight читает metadata/версии/auth, но не посылает model prompt
RUN_HOST_PREFLIGHT=1 bin/factory-check arsenkin --host-preflight

bin/factory 8126 runner show
bin/factory 8126 runner set REVIEW codex --failover claude
bin/factory 8126 runner switch REVIEW codex
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
bin/factory profile arsenkin debug set errors

# временно одна задача; без --for действует два часа
bin/factory 8126 debug set verbose --for 2h
bin/factory 8126 debug show
bin/factory 8126 debug clear

# явно выключить для всей фабрики
bin/factory settings debug set off
```

Уровни: `off`, `errors`, `decisions`, `verbose`; приоритет —
`задача → проект → глобальная настройка → off`. Trace лежит рядом с run в
`state/logs/runs/t<TASK>/<STAGE>/<run-id>/debug.trace.jsonl`. В него не попадают prompt,
credentials, environment и status/control tokens. Настройки хранятся отдельно от
`runners.env`, поэтому включение debug не сбрасывает coverage.

Тот же глобальный переключатель доступен в Cockpit: «Настройки → Запуски →
Диагностическое логирование фабрики». UI вызывает engine writer через API и не хранит
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
  runners/             независимые модули CLI (Claude, Codex, будущие providers)
  dispatcher.sh        белый список причин переключения + circuit breaker
  run-state.sh         run-id/epoch/capability CAS terminal status
  runner-cli.sh        project/stage/task routing и runtime switch
  debug-settings.sh    global/profile/task debug settings, precedence и expiry
  debug-log.sh         typed trace, runtime on/off, redaction, size limit и TTL
  pipeline-set.sh      машина статусов (upsert + телеметрия; --init / --replan / --reject-accept)
  dashboard.py         реализация резервного интерфейса и эталон части логики графа
profiles/                   локальный каталог, целиком вне Git
  <name>/
    profile.sh         стек-контекст, этапы маршрутов, хуки стенда, промпты этапов
    runners.env        обязательная runner/model policy проекта
    dashboard.env      проектные пути/контейнеры/трекер для дашборда
    graph.json         схема маршрутов: узлы, петли возврата, optional (нужна кокпиту)
    up.sh, down.sh…    проектное хозяйство: провижн, озвучка, склейка демо
../docs/engine/         документация и план развития движка
../tests/engine/        unit, contract, integration, race и проверки профилей
```

**Данные (вне репозитория):** `~/.factory/state/` —
`tNNNN.pipeline` (реестр статусов задачи — единственный источник истины), `logs/`, `archive/`,
`shots/` (скриншоты браузера), `demo/` (видео).

---

## Добавить новый проект

Движок не знает ни одного проекта: этапы, промпты, стенд и схема живут в профиле.

```bash
bin/factory-new <имя> [корень проекта]   # скелет профиля + runner policy + env + схема
# заполнить TODO в profiles/<имя>/profile.sh (см. ../docs/engine/NEW-PROJECT.md)
# довести схему: подписи узлов, петли возврата, optional (штатные пропуски)
bin/factory-check <имя> --quick          # offline: контракт, промпты, доступ и схема
RUN_HOST_PREFLIGHT=1 bin/factory-check <имя> --host-preflight  # без model prompt
bin/factory <TASK> start --profile <имя> --ticket "…"
```

Профиль состоит из:

- **`profiles/<имя>/profile.sh`** — контекст стека, маршруты (`PROFILE_ROUTE_STAGES_<маршрут>`), промпты
  этапов, хуки стенда и доступ агента (`PROFILE_AGENT_DIRS` / `PROFILE_AGENT_ALLOW`);
- **`profiles/<имя>/runners.env`** — обязательные primary/failover и family policy моделей;
- **`profiles/<имя>/dashboard.env`** — пути, контейнер стенда, трекер и базовый URL задач;
- **`profiles/<имя>/graph.json`** — схема конвейера: узлы, петли возврата и `optional` (этапы,
  чей пропуск не аномалия). Нужна обязательно — кокпит без неё профиль не показывает.
  Заготовку из маршрутов делает `bin/factory-graph-new <имя>`, дальше подписи и петли — руками.

Подробно, с вопросами, которые надо задать до написания профиля:
**[NEW-PROJECT.md](../docs/engine/NEW-PROJECT.md)**.

## Устойчивость (что сделано, чтобы не разваливалось)

- **Cockpit** — основной UI под systemd; движок запускается в отдельном scope и не привязан
  к жизненному циклу веб-сервера. Python-dashboard остаётся ручной диагностикой.
- **Наблюдатель** отличает «завис» (журналы агента молчат >15 мин) от «ждёт человека на воротах».
- **Санити графа**: один активный узел (инвариант линейности); пропущенный обязательный этап — красная
  аномалия, а не тихий пропуск; приёмка при недоделанном хвосте — «преждевременно», а не «готово».
- **Обе петли возврата**: отклонил план → в планирование (`--replan`); отклонил приёмку → в сборку
  (`--reject-accept`, тесты остаются заморожены).

---

## Профили

| Профиль | Проект | Стек | Стенд |
|---|---|---|---|
| `arsenkin` | arsenkin.ru | Laravel 12 + Restify (BE), Vue 3 + Vite (FE), мультитенант MySQL + ClickHouse, Horizon | своя песочница на задачу |
| `cockpit` | этот репозиторий | Fastify + Vue 3 / Vite | изолированный dev-экземпляр на задачу |
| `rdesigner` | локальный ИИ-дизайнер интерьера | Python + 3D-пайплайн (чертёж → 3D → кадр) | один общий постоянный |
