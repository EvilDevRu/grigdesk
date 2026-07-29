# Handoff: автоматическое ревью и исправление PR

Дата фиксации: 2026-07-30

Базовый commit до работы: `572b28a`

Checkpoint-ветка: `wip/pr-review-checkpoint`

Ветка создаётся от локальной `main`, которая в этой точке на 42 commit впереди
`origin/main`. Не пересоздавать checkpoint от `origin/main`: из него пропадут уже
принятые изменения Cockpit, на которых основан review-контур.

## Зачем нужен этот документ

Это точка продолжения для разработчика или агента, у которого нет истории чата.
Целевой пользовательский процесс и полный TDD-каталог описаны в
[pr-review-fix-plan.md](./pr-review-fix-plan.md). Этот документ отвечает на другие вопросы:

- что уже реализовано фактически;
- что намеренно отключено;
- где лежат основные части системы;
- почему функцию пока нельзя выпускать как автоматический исправлятор;
- в каком порядке безопасно продолжать;
- какими тестами доказывать каждый следующий шаг.

## Короткий статус

Общая готовность исходного замысла на момент остановки — примерно **60%**.

В исполняемом manifest сейчас 149 обычных критериев:

- 93 имеют статус `required`;
- 56 остаются `planned`;
- обычный offline-suite проходит;
- release-gate намеренно не проходит, пока существует хотя бы один `planned`.

Процент — ориентир, а не release-метрика. Источник правды:
`tests/docs/review-test-manifest.test.mjs`.

Оставшиеся 56 `planned` на момент checkpoint:

```text
00-test-contour:
  RB-04 RB-06 RB-07
01-project-binding:
  MAP-01 MAP-08
02-github-sync:
  SYNC-07 SYNC-10 SYNC-11
03-watcher:
  WATCH-08 WATCH-RACE-03 WATCH-RACE-04
04-analysis:
  ANALYZE-09
05-translation:
  TRANSLATE-08
06-human-gates:
  GATE-01 GATE-02 GATE-04 GATE-09
07-run-state:
  RUN-05 RUN-06 RUN-07
08-runtime-isolation:
  ISOLATE-03 ISOLATE-04 ISOLATE-05 ISOLATE-06 ISOLATE-07
09-execution-security:
  SEC-01 SEC-02 SEC-03 SEC-04 SEC-05 SEC-06 SEC-08 SEC-09 SEC-10
10-verification:
  VERIFY-04
11-freshness:
  FRESH-01 FRESH-02 FRESH-03 FRESH-04 FRESH-05 FRESH-06 FRESH-07
12-publication:
  PUBLISH-08 PUBLISH-09
13-interface:
  UI-01 UI-06 UI-09 UI-10 UI-11
14-queue-recovery:
  QUEUE-02 QUEUE-03 QUEUE-04 QUEUE-06 QUEUE-07 QUEUE-08 RECOVER-01
```

Некоторые test-файлы уже содержат дополнительные regression-сценарии с похожими ID.
Это не повод механически менять `planned` на `required`: статус переводится только после
проверки полного смысла критерия из основного плана.

### Что уже можно использовать

Готов входящий read-only контур:

1. Project связывается с конкретным GitHub `owner/repository`.
2. Cockpit сам опрашивает подтверждённые репозитории.
3. Открытые PR и замечания сохраняются независимо от обычных Factory-задач и песочниц.
4. У замечаний есть устойчивые GitHub ID и версия, включающая head SHA, состояние и текст.
5. Новые замечания автоматически попадают в durable-очередь анализа.
6. Технический анализатор возвращает структурированную рекомендацию.
7. Отдельный «Переводчик» превращает её в понятное объяснение без изменения смысла.
8. В сайдбаре показывается чип с количеством разных PR, требующих внимания.
9. На `/reviews` видны исходные замечания, рекомендации, состояния и ручной повтор анализа.
10. На странице Projects есть настройка GitHub-привязки и ручная проверка.
11. Очереди переживают рестарт, истёкшие lease, stale-результаты и разрыв между анализом
    и постановкой перевода.
12. SSE служит только сигналом перечитать канонический снимок с сервера; локального
    инкремента счётчика нет.

### Что нельзя считать готовым

Автоматическое изменение кода **не подключено к production runtime**.

В коде есть экспериментальные заготовки:

- разбор Factory review-route из профиля;
- отдельное состояние review-run;
- host-side worktree и временная ветка;
- структурированный BUILD/REVIEW model adapter;
- VERIFY через `bubblewrap`;
- freshness-gates и публикация через точный Git ref.

Эти части покрывают ряд локальных контрактов, но не доказывают, что настоящий Factory:

- создал отдельную runtime-песочницу для PR;
- поднял нужные companion-репозитории;
- изолировал контейнеры, БД, Redis, порты, процессы и диск;
- выполнил browser/Playwright-проверки;
- корректно пережил весь crash/retry matrix;
- очистил все ресурсы без влияния на другие PR.

Поэтому `createReviewRepositoryProvider()` по умолчанию выставляет
`factoryReviewExecutorAvailable = false`, `canFix = false`, а UI честно показывает режим
«только просмотр и анализ».

Все пишущие входы fail-closed с `REVIEW_EXECUTOR_UNAVAILABLE`, включая:

- создание нового run;
- восстановление старого queued/approved/built run после рестарта;
- BUILD и VERIFY из scheduler;
- accept;
- publish и reconcile неизвестной публикации;
- повторную проверку перед публикацией.

**Нельзя продолжать работу простым переключением этого флага в `true`.**

## Последняя подтверждённая проверка

Перед созданием checkpoint рабочее дерево прошло:

```bash
bash tests/run-all.sh
npm --prefix web run build
git diff --check
```

Результат последнего полного прогона рабочего дерева:

- docs/layout/engine offline — успешно;
- server — 299 тестов успешно;
- web — 73 теста успешно;
- production web build — успешно;
- отдельный review/security-прогон — 208 тестов успешно.

После сборки Cockpit получил команду на systemd-restart, API принял её. Финальная
health-проверка после этого рестарта не выполнялась, потому что работа была остановлена
по просьбе пользователя.

Чистый staged snapshot будущего checkpoint отдельно проверен без постороннего WIP:

```bash
node --test tests/docs/review-test-manifest.test.mjs
bash tests/engine/run-offline.sh <каждый review-файл>
node --test \
  tests/server/review-*.test.js \
  tests/server/gateway-cookie-boundary.test.js \
  tests/server/claude-mcp-secret.test.js
node --test \
  tests/web/projects-view.component.test.js \
  tests/web/review-*.test.js \
  tests/web/reviews-view.component.test.js
npm --prefix web run build
```

Результат чистого snapshot:

- docs manifest — 2/2;
- review engine — 37/37;
- review server/security — 208/208;
- review web — 21/21;
- production web build — успешно.

У базового commit есть отдельный дефект воспроизводимости, не относящийся к review:
общий `.gitignore` исключает `*.log`, но старый classifier-suite требует шесть локальных
fixture-файлов, которые существуют в рабочем каталоге и не отслеживаются Git:

```text
tests/engine/fixtures/classifiers/claude-synthetic-limit/stderr.log
tests/engine/fixtures/classifiers/claude-synthetic-limit/stdout.log
tests/engine/fixtures/classifiers/codex-synthetic-limit/stderr.log
tests/engine/fixtures/classifiers/codex-synthetic-limit/stdout.log
tests/engine/fixtures/classifiers/codex-denied/stderr.log
tests/engine/fixtures/classifiers/codex-denied/stdout.log
```

Поэтому `bash tests/run-all.sh` в исходном смешанном рабочем дереве зелёный, а в чистом
checkout останавливается на старом `classifier-fixtures.sh`. Эти чужие fixture-файлы
сознательно не добавлены в review checkpoint. Их следует исправить отдельным base-коммитом:
явно разрешить и добавить fixtures либо изменить старый тестовый контракт.

После этого снова выполнить:

```bash
bash tests/run-all.sh
npm --prefix web run build
COCKPIT_REVIEW_RELEASE_GATE=1 \
  node --test tests/docs/review-test-manifest.test.mjs
```

Первые две команды должны пройти. Последняя обязана упасть и перечислить оставшиеся
`planned`: до завершения review-плана это ожидаемое поведение, а не регрессия.

## Карта реализации

### Серверный входящий контур

| Файл | Ответственность |
|---|---|
| `server/src/lib/reviews/identity.js` | Устойчивые ID, версии замечаний и digest снимков |
| `server/src/lib/reviews/github.js` | GitHub GraphQL pagination, PR, threads и комментарии |
| `server/src/lib/reviews/store.js` | Durable inbox, analysis/translation artifacts, model jobs, lease и retention |
| `server/src/lib/reviews/watcher.js` | Фоновый sync, coalescing, cooldown, trust policy и постановка анализа |
| `server/src/lib/reviews/analyzer.js` | Контракт технического анализа и durable analysis queue |
| `server/src/lib/reviews/translator.js` | Человеческая карточка и восстановление потерянного translation outbox |
| `server/src/lib/reviews/model-adapter.js` | Одноразовый read-only запуск модели без инструментов |
| `server/src/lib/reviews/service.js` | Project binding, snapshot для UI, scope, gates, scheduler и orchestration |
| `server/src/lib/reviews/degraded.js` | Fail-closed API, если review subsystem не инициализировалась |
| `server/src/modules/reviews/index.js` | HTTP API `/api/reviews` |

### Экспериментальный пишущий контур

| Файл | Текущее состояние |
|---|---|
| `server/src/lib/reviews/factory-route.js` | Читает и валидирует descriptor из доверенного profile |
| `server/src/lib/reviews/review-state-machine.js` | Durable state transitions и immutable approvals |
| `server/src/lib/reviews/control-store.js` | Scope, links, active runs, очередь и scheduler claims |
| `server/src/lib/reviews/build-agent.js` | Tool-free модель возвращает ограниченный набор файлов |
| `server/src/lib/reviews/runner.js` | Host-side worktree, commit и экспериментальный VERIFY |
| `server/src/lib/reviews/publisher.js` | Git CAS, operation id и reconcile публикации |

Наличие этих файлов не означает наличие Factory runtime executor.

## Ограничения доказательств на момент остановки

- Реального canary с GitHub, моделью, Factory runtime и браузером не было.
- Offline fake GitHub/model доказывают контракты и гонки, но не качество русской
  рекомендации на настоящих PR.
- Direct Codex BUILD и `bubblewrap` VERIFY — scaffolding, а не production Factory sandbox.
- Не реализованы companion repositories с зафиксированными base refs.
- Не доказаны отдельные DB, Redis, порты и container namespaces для параллельных PR.
- Нет browser/Playwright evidence и скриншотов.
- Нет полного resource policy для CPU, RAM, PID и disk.
- VERIFY чистого tracked tree может не иметь зависимостей; provisioning должен решать это
  явно, без неявного доступа к host `node_modules` или сети.
- Полная межпроцессная crash/retry/cancel матрица ещё не закрыта.

Поэтому нельзя утверждать, что «Factory подключён», «песочницы уже поднимаются»,
«автоисправление работает» или «обычный зелёный suite доказывает release readiness».

### Интеграция с Cockpit

| Файл | Ответственность |
|---|---|
| `server/src/app.js` | Создание review subsystem и degraded fallback |
| `server/src/lib/projects.js` | Безопасная нормализация GitHub remote и Project binding |
| `server/src/modules/projects/index.js` | API привязки, проверки и запрет rebind при активном run |
| `server/src/plugins/auth.js` | Capability boundaries для browser, CLI и internal MCP |
| `web/src/stores/reviews.js` | Канонический client snapshot, SSE refresh и защита logout/race |
| `web/src/shared/review-chip.js` | Сводка, приоритет цвета, безопасный Markdown и перевод карточки |
| `web/src/views/ReviewsView.vue` | Страница входящих PR и ручные действия |
| `web/src/views/ProjectsView.vue` | Настройка GitHub-привязки и статус репозитория |
| `web/src/shared/layout/AppShell.vue` | Пункт сайдбара и чип |

### Durable state

По умолчанию review-состояние находится в `server/.state/reviews`:

- inbox и model jobs;
- control state и связи run;
- состояния отдельных review-run;
- временные worktree экспериментального runner.

Каталог содержит локальные данные и не должен попадать в Git.
Секреты GitHub в review state не сохраняются.

## Доказанные инварианты, которые нельзя сломать

### Идентичность и свежесть

- Номер PR или комментария сам по себе не является ID.
- Результат применяется только к точной версии замечания и head SHA.
- Поздний анализ старого текста не заменяет текущий.
- Закрытый или resolved комментарий не возвращается в чип из-за позднего worker.
- Изменение одного элемента batch не должно отменять работу неизменного соседа.

### Очереди

- Job durable и имеет lease с fencing token.
- Старый worker после потери lease не может записать artifact.
- Истёкшая последняя попытка материализуется как видимая ошибка, а не вечный
  `pending`/`translating`.
- Готовый analysis без translation автоматически восстанавливает отдельную translation-job.
- Terminal failure того же analysis не зацикливает автоматический retry.
- Ручной новый analysis может восстановить перевод после terminal failure старого analysis.
- Поток analysis не может бесконечно вытеснять translation.

### UI

- Чип считает разные PR, не комментарии.
- Приоритет цвета: красный, затем жёлтый, затем синий.
- «Прочитано» снимает только синее внимание.
- SSE не меняет счётчик напрямую.
- Поздний initial full GET не может затереть более новый снимок после SSE.
- Logout не позволяет позднему запросу вернуть приватные тексты в память вкладки.
- Исходный GitHub Markdown и текст модели проходят общий sanitizer.
- Resolved/outdated замечание не показывает невозможную кнопку анализа.

### Безопасность

- Текст PR и код считаются недоверенными инструкциями.
- Read-only анализ не получает publisher и пишущие инструменты.
- Internal MCP token не является общей сессией API.
- CLI token ограничен своими маршрутами.
- Полная `cockpit_sid` остаётся host-only.
- Стендам передаётся отдельная gateway capability, которая не открывает review API.
- Reverse proxy вырезает Cockpit cookies перед передачей запроса к коду стенда.
- Публикация использует точный ref и compare-and-swap, а не произвольный force push.

## Почему нельзя использовать существующий `factory <TASK>`

Текущий task-конвейер привязан к:

- числовой задаче;
- task state;
- task branch;
- обычному profile sandbox;
- истории первоначального выполнения задачи.

Review-run должен быть привязан к GitHub repository node ID, PR node ID, head SHA и версии
scope. Попытка завернуть PR в фиктивную задачу снова смешает жизненные циклы и создаст риск
использовать ветку или песочницу другого PR.

Нужен отдельный Factory review executor либо новый общий runtime primitive, которому явно
передаются:

- уникальный `reviewRunId`;
- Project и repository binding;
- точный Git remote, head ref и head SHA;
- descriptor разрешённого Factory route;
- companion repositories и их зафиксированные base refs;
- namespace ресурсов;
- лимиты;
- lifecycle hooks provision, execute, verify, inspect и destroy.

## Порядок продолжения

### Шаг 0. Воспроизвести checkpoint

1. Переключиться на `wip/pr-review-checkpoint`.
2. Убедиться, что read-only раздел запускается, а `canFix` остаётся `false`.
3. Выполнить обычный offline-suite и web build.
4. Запустить release-gate и сохранить список `planned`.
5. Не менять production-флаг доступности executor.

### Шаг 1. Зафиксировать контракт Factory review executor

Сначала тесты, затем код.

Нужно определить отдельный интерфейс примерно такого уровня:

```text
probe(project, repository, route) -> capability
provision(reviewRun, exactSource, resourcePolicy) -> runtimeBinding
build(runtimeBinding, approvedScope) -> candidate
verify(runtimeBinding, verificationPlan) -> report
inspect(runtimeBinding) -> health/resources
destroy(runtimeBinding, reason) -> cleanupReport
recover(reviewRun) -> recoveredState
```

Контракт должен:

- не принимать номер Factory-задачи как идентичность;
- не выбирать ветку по локальному текущему checkout;
- быть идемпотентным по `reviewRunId` и operation ID;
- сохранять runtime binding до побочного эффекта;
- иметь fencing token на каждый долгий этап;
- возвращать доказательства, а не только строковый success;
- fail-closed, если Factory profile или нужная изоляция недоступны.

Первый полезный результат шага — executor, который умеет `probe/provision/destroy` в
настоящем Factory runtime и проходит новые обязательные тесты, но ещё не меняет код.

### Шаг 2. Реализовать отдельную runtime-изоляцию каждого PR

Для каждого review-run нужны уникальные:

- filesystem/worktree;
- branch;
- runtime/container namespace;
- project name контейнерного оркестратора;
- порты;
- DB/Redis namespace или отдельные экземпляры;
- каталог логов и скриншотов;
- PID/cgroup/resource scope.

Обязательные свойства:

- источник — точный remote head SHA PR;
- локальная незакоммиченная ветка не используется;
- соседний PR не виден;
- секретные пути и `.git` недоступны модели;
- сеть по умолчанию закрыта и открывается только явной policy;
- CPU, RAM, PID, disk и timeout ограничены;
- повторный `provision` не создаёт дубликаты;
- `destroy` безопасен после частично выполненного provision;
- restart Cockpit восстанавливает или завершает cleanup.

До доказательства этих свойств `factoryReviewExecutorAvailable` остаётся `false`.

### Шаг 3. Перенести BUILD и VERIFY за Factory boundary

Экспериментальный host-side runner можно использовать как источник контрактов, но не как
production security boundary.

Нужно:

1. Передавать только утверждённый immutable scope.
2. Разрешать изменения только в `allowedPaths`.
3. Отдельно подтверждать рискованные инфраструктурные пути.
4. Запускать BUILD и независимый REVIEW в разных model sessions.
5. Применять результат на host только после schema/path/symlink/size validation.
6. Делать commit только из tracked candidate diff.
7. Выполнять baseline и candidate проверки в одинаковой чистой среде.
8. Связать каждый критерий готовности с конкретным доказательством.
9. Для UI-сценариев запускать browser/Playwright и сохранять скриншоты.
10. Возвращать понятный отчёт: что изменено, что проверено и какой риск остался.

### Шаг 4. Закрыть freshness и publication matrix

Повторно проверять GitHub и immutable конфигурацию:

- перед provision;
- перед BUILD;
- после BUILD;
- перед VERIFY;
- после VERIFY;
- перед accept;
- непосредственно перед push;
- после сетевой неопределённости при reconcile.

Run становится stale, если изменились:

- PR head SHA;
- версия выбранного замечания;
- утверждённый scope;
- Factory route revision;
- verification policy;
- repository binding;
- fork/ref назначения.

Публикация должна оставаться ручной. Нужны exact fork URL, exact branch ref, expected-old SHA,
operation ID и reconcile по remote ref. Не публиковать из локального `origin`, если он лишь
похож на ожидаемый.

### Шаг 5. Доделать scheduler, recovery и cleanup

Нужно закрыть оставшиеся `QUEUE-*`, `RECOVER-*`, `RUN-*` и `ISOLATE-*`:

- несколько PR одновременно без смешивания ресурсов;
- fairness между Project/repository;
- ограничение глубины очереди;
- отмена queued и running run;
- restart во время каждого этапа;
- потеря lease непосредственно перед побочным эффектом;
- terminal retry budget;
- cleanup после success, failure, cancellation и crash;
- ручная диагностика orphan runtime;
- retention логов, артефактов и скриншотов.

### Шаг 6. Включить полный UI-процесс

Только после появления реальной capability:

- показать выбор действий `Исправить / Ответить / Пропустить / Нужно решение`;
- редактировать критерий готовности и allowed paths;
- запускать отдельный run для каждого PR;
- показывать очередь и runtime status;
- показывать diff, тесты и скриншоты;
- дать принять или отклонить результат;
- оставить publish отдельной явной кнопкой;
- объяснять stale/error человеческим языком;
- не скрывать отсутствие Factory capability.

### Шаг 7. Release hardening

Для каждого следующего блока:

1. Выбрать минимальный `planned` ID.
2. Перевести его в `required` **до реализации**.
3. Добавить настоящий red test в указанном runner.
4. Реализовать минимальный production-код.
5. Запустить targeted tests.
6. Запустить `bash tests/run-all.sh`.
7. Проверить fault injection и restart соответствующего этапа.

Release разрешён только когда:

- `plannedIds` пуст;
- `COCKPIT_REVIEW_RELEASE_GATE=1` проходит;
- все обычные offline-тесты проходят;
- production web build проходит;
- реальный canary PR прошёл Factory provision, BUILD, VERIFY, accept, publish и cleanup;
- два параллельных canary PR доказали отсутствие смешивания;
- security review подтвердил границы secrets/cookies/network/filesystem;
- оператор может диагностировать и безопасно очистить orphan runtime.

## Как выбирать следующий TDD-блок

Не нужно пытаться закрыть все 56 `planned` одним изменением.

Рекомендуемый первый вертикальный срез:

1. `ISOLATE-03`: настоящий Factory executor обязателен, host fallback запрещён.
2. `ISOLATE-04`: namespace ресурсов двух PR различается.
3. `ISOLATE-05`: лимиты и закрытая сеть реально применены.
4. `ISOLATE-06`: restart восстанавливает или очищает provision.
5. `ISOLATE-07`: cleanup идемпотентен и не затрагивает соседа.
6. Затем `SEC-01`–`SEC-06` для BUILD boundary.
7. Затем `VERIFY-04`, browser evidence и оставшиеся freshness-критерии.

Если точный смысл ID неясен, сначала открыть соответствующий раздел
`pr-review-fix-plan.md`; manifest указывает ожидаемый файл и runner.

## Команды для продолжения

Быстрые targeted-прогоны:

```bash
node --test tests/server/review-*.test.js
node --test \
  tests/server/gateway-cookie-boundary.test.js \
  tests/server/claude-mcp-secret.test.js
node --test \
  tests/web/review-chip-model.test.js \
  tests/web/review-store.test.js \
  tests/web/review-markdown.test.js \
  tests/web/reviews-view.component.test.js \
  tests/web/projects-view.component.test.js
bash tests/engine/integration/review-isolation.sh
bash tests/engine/integration/review-verify.sh
bash tests/engine/race/review-run-fencing.sh
```

Обязательная проверка перед каждым checkpoint:

```bash
bash tests/run-all.sh
npm --prefix web run build
git diff --check
```

Пока не исправлены шесть старых classifier fixtures из раздела выше, в чистом checkout
дополнительно запускать review-targeted набор и не выдавать известный base-failure за
регрессию review-кода.

Release-gate:

```bash
COCKPIT_REVIEW_RELEASE_GATE=1 \
  node --test tests/docs/review-test-manifest.test.mjs
```

## Известные ловушки

- Не использовать `syncedAt` как смысловое изменение snapshot.
- Не отправлять SSE до durable записи итогового состояния.
- Не показывать статус по job старой версии замечания.
- Не считать analysis готовым, пока нет соответствующего translation, но и не оставлять
  сиротский перевод без recovery-job.
- Не отменять полезного соседа только потому, что один элемент batch стал stale.
- Не позволять terminal job автоматически зациклиться.
- Не давать analysis queue вытеснять translation бесконечно.
- Не считать `systemd-run --scope` security sandbox: это только lifecycle grouping.
- Не использовать локальный checkout Project как доказательство exact PR source.
- Не выполнять сохранённые verify commands через shell.
- Не передавать секреты через argv, логи, SSE или review state.
- Не давать gateway-cookie права Cockpit session.
- Не помечать run stale только потому, что executor временно недоступен: это blocked/runtime
  capability error, а не изменение PR.
- Не вызывать publish/reconcile до проверки runtime binding и executor capability.
- Не включать кнопки исправления только потому, что descriptor Factory route успешно прочитан.

## Что считать следующим завершённым checkpoint

Следующий checkpoint имеет смысл создавать не после очередной модели или UI-кнопки, а когда:

1. Cockpit получает проверяемую capability настоящего Factory review executor.
2. Два PR получают разные runtime namespace.
3. Один PR может пройти provision и destroy после имитированного crash.
4. Host-native fallback отсутствует.
5. `ISOLATE-03`–`ISOLATE-07` переведены в `required` и проходят.
6. `factoryReviewExecutorAvailable` вычисляется из реального probe, но BUILD всё ещё можно
   оставить закрытым отдельным feature gate до завершения SEC/VERIFY.

Это даст безопасный фундамент для оставшихся 40% работы.
