# Добавление нового исполнителя (раннера) в Factory

Как добавить нового ИИ-провайдера в движок конвейера: контракт адаптера, порядок
поставки, обязательные тесты и решения, которые нельзя принимать молча.

Прецеденты: [MULTI-AI.md](MULTI-AI.md) (первый второй провайдер, TDD-порядок и критерии
готовности — разделы «TDD и порядок поставки» и «Критерии готовности runtime») и
план Kimi-раннера — локальный черновик `docs/plans/kimi-factory-runner-plan.md` вне
репозитория (актуальный пример прохождения этого пути, включая критику и упрощение
security-рамки).

## Что раннером является и чем не является

Инфраструктура failover полностью provider-agnostic: реестр раннеров по имени файла
(`lib/runners/index.sh`), dispatcher/breaker/routing (`lib/dispatcher.sh`,
`lib/routing.sh`), coverage/preflight (`lib/coverage.sh`, `lib/profile-preflight.sh`),
ручной switch (`lib/runner-cli.sh`). Добавить провайдера в цепочку профиля — одна строка
в `runners.env`. Работа — не «записать в список», а сделать переключение на него
предсказуемым: движок должен узнавать «лимиты кончились» только по доказанным
признакам, а не по догадке (догадка = риск выполнить стадию дважды).

Раннер — это файл `lib/runners/<id>.sh`, адаптер между движком и CLI провайдера.
id — `^[a-z][a-z0-9_-]*$` (`index.sh:11`); реестр сканирует каталог, служебные имена
`index`/`policy`/`catalog` пропускаются (`index.sh:18-26`).

## Контракт

`runner_contract_check` (`index.sh:38-44`) требует 8 функций `runner_<id>_<method>`:

| Функция | Семантика |
|---|---|
| `probe` | Доступность CLI и наблюдаемая версия. Нет CLI — `return 4`. Политика совместимости принадлежит адаптеру: semver-пин допустим, но раннер с доказанным version-agnostic fail-closed контрактом не обязан отвергать обновление только из-за номера. |
| `catalog` | models.tsv на stdout (id, провайдер, family, версия, …) или `return 4`. Pinned-список допустим и предпочтителен для провайдеров без читаемого локального каталога. Последние поля — min/max runtime; `*` означает явно выбранную совместимость по контракту без semver-границы. |
| `capabilities` | Слова из `status status_request status_fd sandbox tools structured_output fanout native_resume_v1`. Заявлять только доказанное: `status_fd` — если fd 7 проверен, `sandbox` — только при реальной границе, `native_resume_v1` — только при exact provider scope и fail-closed resume-контракте ниже. |
| `run` | Сигнатура `(task, prompt, stage, model, effort, timeout_s, run_dir)`. Запуск под `timeout -k 30 "$timeout_s"` (TERM без KILL оставляет провайдера жить с занятым слотом — `codex.sh:149-150`). stdout — только событийный поток в диалекте CLI: он попадает в host-safe-open `events.jsonl`, любой шум обёртки ломает classify и usage normalization. Мост допустим (`kimi.sh` подмешивает события субагентов, невидимые в потоке CLI), но обязан быть ЕДИНСТВЕННЫМ писателем — труба, а не второй параллельный писатель в тот же fd: строки CLI бывают в десятки килобайт, то есть много больше PIPE_BUF, и атомарность append не гарантируется. Исход хода берётся у CLI (`PIPESTATUS[0]`), сбой моста не имеет права стать отказом стадии. add-dirs — из env `RUNNER_<ID>_ADD_DIRS` (проводка в `core.sh:380-404`). До входа в adapter `runner-bridge.sh` держит child на launch barrier; adapter не создаёт обходной provider process до снятия барьера. |
| `classify` | См. отдельный раздел ниже. |
| `fanout_count` | Сигнатура `(run_dir)`, число делегирований за ход в `FANOUT_<STAGE>`. Источник ищется в таком порядке: событийный поток (`claude.sh` — `Agent`/`Task`; `codex.sh` — разные треды-получатели `collab_tool_call`), затем собственная телеметрия CLI, если в поток он делегирования не публикует (`kimi.sh` читает `wire.jsonl` per-run home). Разбором JSON, а не грепом по имени инструмента: снимок доступных инструментов содержит его ОПИСАНИЕ, и греп даст ненулевой счёт на ходе без единого делегирования. **Константа `0` источником не является**: на прогонах без делегирования она неотличима от замера, а первое же делегирование она молча пропустит — вернуть `0` должен код, который посмотрел и не нашёл. |
| `dialect` | Однострочное описание формата потока CLI. |
| `interrupt` | Launcher владеет setsid-сессией и глушит её целиком; раннеру без собственной песочницы достаточно `return 0` (`codex.sh:253-255`). Если обёртка выводит дерево из сессии (systemd-run, `bwrap --new-session`), раннер обязан добивать его сам — иначе остаются сироты. |

Условно обязательные (в contract_check не входят, но нужны движку):

- `default_policy` — вызывается при отсутствии `MODEL_*_<ID>_*` в профиле
  (`multi-runner.sh:161-169`). Без неё кандидат получает `route_unavailable`, а host
  preflight — `structural_level=unavailable`, что роняет весь профиль
  (`profile-preflight.sh:89-96`). Формат — см. `codex.sh:51-53`.
- `family_alias` — фолбэк разрешения семейства при отсутствии каталога
  (`multi-runner.sh:89-94`). Если `catalog` отдаёт models.tsv, достаточно `return 4`
  (`codex.sh:55-57`).
- **`RUNNER_AUTO_COMPACT_WINDOW`** — не функция, а входная переменная `run`: порог автосжатия
  контекста этапа в токенах, уже разрешённый движком (`0` или пусто — не вмешиваться).
  Перевод на диалект своего CLI принадлежит раннеру: `claude.sh` экспортирует
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (и **снимает** её на нуле — унаследованное значение
  иначе переживёт смену настройки), `codex.sh` добавляет `-c model_auto_compact_token_limit=N`.
  У CLI без такой ручки раннер не обязан делать ничего — переменная просто игнорируется.
- `limit_until` — сигнатура `(run_dir)`, unix-время сброса лимита на stdout. Вызывается
  только после исхода `limited` и только если объявлен (`declare -F`, `multi-runner.sh`
  в хвосте `_multi_invoke`); срок неизвестен — `return 1` или пустой вывод. Без него
  предохранитель держит провайдера общий cooldown (900 с), хотя CLI часто называет точное
  время: `claude` кладёт `resetsAt` в машинное событие `rate_limit_event`, `codex` пишет
  фразой «try again at …» (`sed` снимает порядковый суффикс дня и запятую — GNU `date`
  не понимает «Aug 8th, 2026»). Разбор чужого текста ошибается, поэтому границы срока
  раннера не касаются: потолок и отбрасывание прошедшей даты сделаны в `breaker_record` —
  см. [MULTI-AI.md](MULTI-AI.md), «Предохранитель».
- **Runtime usage dialect.** После quiescence launcher разбирает retained original
  `events.jsonl` и пишет расход в schema-2 блок `meta.env` — см.
  [ENGINE.md](ENGINE.md#retained-fd-usage-и-diagnostic-meta-mirror). Для нового provider
  нужно зарегистрировать exact versioned dialect в `_runner_runtime_usage_dialect` и
  добавить raw fixtures. Неизвестный dialect или отсутствие доказуемых counters даёт
  `missing`/`unavailable`, а НЕ ноль: «не сообщил» и «потратил ноль» — разные состояния.

  Два типичных drift-а диалект обязан закрыть тестом. Cumulative provider counters
  (у Codex это `turn.completed`, у Claude — повторы assistant-usage) складывать нельзя:
  расход — дельта к предыдущему принятому снимку, иначе цифра растёт кратно. Cache write
  сохраняется раздельно как 5m, 1h и unknown TTL — у них разный тариф, и смешанный
  `TOKENS_CACHE_WRITE` для показа цены не годится. Оборванный ход без terminal snapshot
  остаётся partial согласно доказуемым samples, а не превращается в бесплатный.
- **Native resume.** Capability `native_resume_v1` разрешён только если adapter различает
  `FACTORY_PROVIDER_SESSION_MODE=fresh|resume`. В `fresh` он обязан запустить новую provider
  session, даже если рабочий каталог содержит старые hints. В `resume` он обязан передать
  CLI ровно `FACTORY_PROVIDER_RESUME_SCOPE`; отсутствие/отказ этого binding — named failure,
  а не fallback на fresh. `FACTORY_PROVIDER_LINEAGE_GENERATION` и
  `FACTORY_PROVIDER_PARENT_USAGE_REF` — read-only provenance; adapter не резервирует, не
  продвигает и не чинит lineage. Обычный `factory resume` не даёт права самостоятельно
  возобновить provider thread.

## classify: fail-closed и ничего лишнего

Сигнатура `classify(run_dir, rc)` → одна строка исхода. Базовый каркас —
`runner_codex_classify` и `runner_claude_classify`:

- `rc=0` → `ok`; `rc=124` → `timeout` — до любых сигнатур.
- Если адаптер объявляет semver-пин, неизвестная версия CLI (из `run_dir/meta.env`)
  → `unknown`. При version-agnostic политике версия остаётся диагностикой, а решение
  принимает только доказанная сигнатура и анализ фактического событийного потока.
  Codex использует второй вариант: общий `runnerFailure.ts` разбирает терминальные
  JSON-события, а текст инструментов не классифицирует. Capacity → `transient`.
- `limited` — weekly/subscription лимит: только по доказанным сигнатурам из fixtures
  или runtime.
- `provider_unavailable` — 401/403 **только при доказанном отсутствии model/tool
  activity** анализатором событийного потока провайдера (для Codex — `inspectCodexFailure`):
  иначе failover перезапустит стадию, которую провайдер мог уже
  частично выполнить.
- `context_overflow` (413) и `transient` (голый 429) — **не переключают**: класс есть,
  failover по нему запрещён.
- Всё сомнительное → `unknown`, автоповтор запрещён (инвариант MULTI-AI.md).

Сигнатуры принимаются только из живого spike или проверенной fixture. Выдуманная
сигнатура хуже отсутствующей: она переключает по ложному поводу.

Класс для автомата и пояснение человеку — отдельные данные. `unknown` не должен
прятать терминальное сообщение. Для Codex retained-FD finalizer сохраняет
диагностические `FAILURE_CODE/MESSAGE/DETAIL`; маршрут и сервер передают их в
[карточку остановки](../cockpit/pipeline/runner-failure-diagnostics.md).

## Порядок поставки (менять нельзя)

1. **Spike** — ручной обезличенный прогон CLI в тестовом каталоге: формат событийного
   потока, exit codes, сигнатуры лимитов/401/403/413/429, поведение permissions в
   headless (что делает CLI, когда спросить некого — виснет?), прерывание по дереву,
   чистота stdout. Результаты — fixtures `tests/engine/fixtures/classifiers/<id>-*`
   и запись в `docs/engine/<ID>.md`.
2. **Тесты первыми, раннера ещё нет.** Регистрация в contract-тестах, fixtures
   классификатора, tripwire, integration-кейсы — всё обязано падать (RED); тест,
   падающий по неправильной причине, чинится сразу.
3. **Критика тестов.** Набор отдаётся состязательному ревьюеру: ложнозелёные проверки,
   непокрытые fail-closed ветки classify, фиктивные fixtures, пропущенные инварианты.
   Замечания встраиваются до реализации, разбор сохраняется рядом с планом/докой.
4. **Реализация** `lib/runners/<id>.sh` до зелёного.
5. **Полный offline suite** (`tests/run-all.sh`) без Cockpit и model calls.
6. **Metadata-only host preflight** профиля с новым кандидатом.
7. **Контролируемый live** — отдельная операция (см. ниже).

## Решения, которые принимаются явно (и записываются в docs/engine/<ID>.md)

- **Security profile.** Есть ли у CLI vendor-sandbox (Codex: `--sandbox`; Claude:
  trusted settings) — тогда раннер собирает его аргументы. Если нет — выбор: строить
  собственную границу (отдельный security-проект, не «строчка в обёртке») или честно
  принять голый запуск с записанным риском (env/ФС/сеть хост-пользователя, как запуск
  из терминала). Молчаливый дефолт недопустим.
- **Permission-режим headless.** В конвейере отвечать на «разрешить?» некому. Нужен
  доказанный spike'ом не-висящий режим; если единственный такой режим разрешает всё,
  включая деструктивное, — это пункт решения оператора перед live-допуском.
- **Политика совместимости CLI** и источник каталога моделей: semver-пин либо явно
  обоснованный version-agnostic контракт. Во втором случае незнакомая форма ошибки
  обязана остаться `unknown`, а фактическая версия — попасть в run metadata.
- **Завершение этапа** — только через `lib/stage-result.sh` (правило движка); env
  статусного протокола должен доходить до агента (через любую обёртку).
- **Принятые риски** — списком, как в плане Kimi-раннера (раздел «Принятые риски»).

## Проводка (чек-лист файлов)

- [ ] `lib/runners/<id>.sh` — адаптер по контракту выше.
- [ ] `lib/executor.sh` — `<id>|<id>-*` в OFFLINE_GUARD.
- [ ] `lib/core.sh` — экспорт `RUNNER_<ID>_ADD_DIRS` в `run_agent`.
- [ ] `lib/runner-launcher.sh` — exact versioned runtime usage dialect; неизвестная версия
      остаётся unsupported, а не заимствует semantics соседней.
- [ ] `tests/engine/fakes/bin/<id>` — tripwire `exit 97` (случайный живой вызов в
      offline-suite не должен проходить незамеченным).
- [ ] Явная регистрация в `tests/engine/contract/runner-contract.sh` и
      `classifier-fixtures.sh` — они не сканируют `lib/runners` сами.
- [ ] `profiles/<test>/runners.env` — тестовая цепочка (`PROJECT_RUNNER_FAILOVER`)
      и модельная политика (`MODEL_DEFAULT_<ID>_*`, при необходимости
      `MODEL_<STAGE>_<ID>_*`); после правки — свежий host preflight.
- [ ] Если заявлен `native_resume_v1`: adapter wiring exact provider scope и contract-cases
      fresh/resume/mismatch/missing checkpoint; lineage store пишет только host.
- [ ] `web/src/shared/runnerDisplay.ts` — label в `PROVIDER_LABELS`; проверить
      `attemptResultLabel` на новых классах исходов; тесты web.

## Тесты (обязательный набор)

- [ ] Fixtures классификатора из spike — `tests/engine/fixtures/classifiers/<id>-*`.
- [ ] Contract: раннер, классификатор, host-preflight coverage (включая кейс
      «провайдер недоступен → профиль не стартует» — это ожидаемое fail-closed).
- [ ] `tests/engine/integration/symmetric-failover.sh` — цепочки в обе стороны:
      limited/permanent переключает, transient/413/unknown — нет.
- [ ] Interrupt/manual switch на fake-дереве — сирот нет.
- [ ] Учёт потребления runtime: raw-фикстуры complete/partial/interrupted, неподдерживаемый
      dialect, подмена пути при удерживаемом FD и неизменяемая публикация одинаковых байтов/
      разных хешей.
- [ ] При `native_resume_v1`: несовпадение document/scope/checkpoint предшественника
      закрывается fail-closed, сбои launch-barrier не запускают provider, а ошибка после
      старта не переиспользует предшественника.
- [ ] При наличии sandbox-обёртки — аналог `sandboxed-status-contract.sh`
      (статусный канал через границу).
- [ ] Web: кейсы `runner-display`.

## Контролируемый live

Отдельная операция после явного разрешения, на disposable-проекте:

1. Тестовый профиль, новый провайдер хвостом цепочки, ни одной primary-стадии.
2. Лимит primary симулируется предустановленным breaker (`breaker_record` — dispatcher
   сам пропустит primary), не живым расходом квоты. Задачу при этом ставить БЕЗ
   `--runner-primary` и без назначения на этап: явный выбор человека предохранитель
   обходит (`SOURCE=task`/`task-stage`), и primary зайдёт в лимит вместо пропуска.
3. Стадия переключилась, результат принят, breaker записан; ручной switch живого run —
   дерево остановлено, сирот нет.
4. Наблюдение: breaker-файлы, cooldown, отсутствие cross-project переноса аварии.
5. Только после стабильного наблюдения — отдельное решение о боевых цепочках. Помнить
   про coverage coupling: профиль с недоступным кандидатом не стартует вообще
   (`coverage.sh:104-105`), поэтому доступность нового стека становится доступностью
   всего профиля.

## Документация при добавлении

- [ ] `docs/engine/<ID>.md` — spike-результаты, security/permission решения, принятые
      риски, критерии готовности (образец — MULTI-AI.md).
- [ ] `docs/engine/ENGINE.md` — карта файлов/инварианты, если затронуты.
- [ ] `engine/README.md`, `engine/CLAUDE.md` — навигация и layout.
- [ ] Этот гайд — если процесс изменился по опыту нового провайдера.
