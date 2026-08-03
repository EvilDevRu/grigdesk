# Устройство Factory Engine

Документ для изменений в `engine/`. Контракт проекта описан в
[PROFILE-CONTRACT.md](PROFILE-CONTRACT.md), создание нового профиля — в
[NEW-PROJECT.md](NEW-PROJECT.md), multi-AI cutover — в [CODEX.md](CODEX.md).

## Инварианты

1. Движок не содержит имён контейнеров, БД, репозиториев и команд конкретного проекта.
2. Каждый локально установленный профиль имеет валидный `profiles/<name>/runners.env`;
   `/profiles/` не отслеживается Git, implicit provider отсутствует.
3. Агент не пишет pipeline напрямую. Terminal result идёт через run-scoped `stage-result`,
   typed failure metadata — через тот же capability, разрешённый progress — через
   `stage-progress`.
4. Любой повтор/switch получает новый `run_id`, больший `epoch` и новую capability.
5. Автоматический failover выполняется только для классифицированных provider failures.
6. Config/state writers используют `flock`, CAS/revision и atomic rename.
7. Offline tests не запускают Cockpit и не выполняют model call.
8. Опубликованный route v2 bundle проверяется engine независимо от server-а; изменение
   `current` не меняет уже закреплённую ревизию.
9. Model/provider/effort отсутствуют в route schema и остаются только в `runners.env`.
10. Guard, locks, capabilities и состояние v2 лежат в `FACTORY_CONTROL_ROOT`, который
    не пересекается с provider-writable `STATE_DIR`.
11. Delivery выводится из закреплённой топологии: нет канонического `ship` — нет delivery
    spec, actions, targets и stage-scoped delivery-команд.

## Карта

| Путь | Ответственность |
|---|---|
| `bin/factory` | CLI, start/resume, обязательные config/protocol gates |
| `bin/factory-check` | profile contract и metadata-only host preflight |
| `bin/factory-route` | offline integrity check, typed prompt render и transition lookup |
| `bin/factory-context` | сборка typed JSON-контекста узла (провайдер-нейтральная) |
| `lib/core.sh` | stage loop, gates, retries, readonly guard |
| `lib/route-runtime.sh` | доверенный диспетчер agent/command v2: pin, рендер, fanout policy, evidence, ретраи и переходы |
| `lib/attempt-stage-state.sh` | курсор, append-only hash-chain, findings projection и no-progress guard |
| `lib/workspace-guard.sh` | точный snapshot source roots без автоматического отката |
| `lib/instrumentation-transaction.sh` | scoped временные правки и CAS cleanup |
| `lib/attempt-state.sh` | изолированные pin/CAS/terminal-файлы попытки route protocol v2 |
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
| `lib/pipeline-set.sh` | ограниченный writer неслужебных полей вторичной проекции |
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

**Адрес стенда в контексте.** `services.frontendUrl`/`apiUrl` собирает `factory-context`
из порта песочницы и хоста `PROFILE_SERVICE_HOST` (умолчание — `127.0.0.1`). Имя вынесено
в профиль не для красоты: приложение вправе отличать локальный запуск от прода по
`window.location.hostname`, и тогда петлевой адрес открывает не тот же стенд, а другой
режим работы. В t8165 браузерная приёмка получила `http://127.0.0.1:5192`, фронт счёл себя
продом (его `isLocal` ищет в имени хоста `localhost`), пошёл за сессией на прод-эндпоинт,
получил 401 и ушёл на прод-путь `/tools/login` — маршрута с таким путём в сборке песочницы
нет, гвард дописывал `?redirect=` и перезагружал страницу заново. За 93 витка адрес вырос
до 2 КБ, страница осталась пустой, а Playwright перестал отвечать вовсе: `evaluate` ждёт
контекст исполнения, который умирает на каждой навигации. Дальше узел просто досидел
до лимита — три зависших вызова MCP по 1800 с, ни одного проверенного сценария.
Мораль движковая: health-check по HTTP («порт отвечает 200») ничего не доказывает
про то, что агент увидит в браузере.

**Лимит времени этапа.** Секунды даёт `_stage_timeout` по классу узла из бандла
(`policy.timeoutClass`), с переопределением профилем; порядок разрешения и таблица
дефолтов описаны в [PROFILE-CONTRACT.md](PROFILE-CONTRACT.md).
Тем же числом `run_agent` приписывает в конец промпта регламент времени: агент иначе
не знает срока и планирует проверки вслепую. Без регламента он может потратить весь остаток
на необязательную регрессию, не успеть отчитаться и потерять вместе с этапом готовый код.
Промпт нигде не хешируется, поэтому приписка безопасна; менять её нужно вместе с тестом
`unit/stage-time-budget.sh`, который сверяет
названные агенту минуты с фактическим `timeout`. Сам `timeout` вызывается с `-k 30`:
провайдер, переживший TERM, иначе остался бы висеть с занятым слотом.

**Контекст повтора.** Ретрай узла — не чистый лист: `route_v2_dispatch_next` считает заход
(`ROUTE_V2_NODE_RETRY`) и причину (`no-result` или `failed`), а `run_agent` приписывает их
в промпт вместе с требованием сначала осмотреть следы предыдущего захода. Без этого повторный
BUILD может заново переписать уже готовый код. Бюджеты попыток при этом не меняются:
считается только то, что и раньше, — сумма `noResult` + `providerFailure` и отдельно
`productFailure`.

**Автоматический rewind конечен и наблюдает прогресс.** Опубликованный route задаёт цель и
reset-набор. Для legacy failed без metadata сохраняется старый предохранитель: два одинаковых
`node → rewind-target`, третий даёт `kind=rewind-limit`/`stop=rewind-limit`. Typed failed получает
широкий hard ceiling шесть, но обычно останавливается раньше: третий подряд одинаковый fingerprint
`owner + sorted finding ids` либо цикл `A→B→A→B→A` атомарно пишет `kind=no-progress` и
`stop=no-progress`. Изменившийся набор findings считается прогрессом. Обе проверки находятся
внутри locked append; `goto` человека кладёт `human-rewind`, сбрасывает историю автономной дуги
и передаёт причину следующему агенту. Решения ворот в автоматический бюджет не входят.

**Findings — производная журнала.** Typed verdict сохраняется в immutable commit event. API
`attempt_stage_state_findings_v2` сначала проверяет весь hash-chain, затем строит `open/closed`:
повторный failed обновляет полный набор findings source-узла, а `done` того же узла закрывает
его открытые пункты. Отдельного изменяемого ledger-файла нет. `factory-context` публикует эту
проекцию в `evidence.findings`, поэтому автор получает точный незакрытый долг, а reviewer
переиспользует стабильные id вместо полного забывания предыдущего круга.

**Черновик хода.** Этап атомарен: пока агент не вызвал `stage-result`, для конвейера ничего
не произошло, и убитый по таймауту заход уносит с собой всё, что успел понять. Поэтому
`run_agent` даёт агенту файл `$STATE_DIR/t<TASK>.<этап>.checkpoint.md` (`_stage_checkpoint_path`)
и в регламенте времени просит дописывать туда строку после каждого осмысленного куска.
Канал именно файловый, а не `stage-progress`: тот проверяет ключи по фиксированному
маршрутному списку (ROUTE/SIZE/PLANS/…) и произвольный текст не примет by design — расширять
его под заметки значит ломать смысл нетерминального API. Права на `STATE_DIR` у агента и так
есть, лишней поверхности не появилось. Следующий заход получает `tail -c 6000` черновика
отдельным блоком, и отдаётся он **по наличию непустого файла, а не по номеру захода**: после
убитого оркестратора resume входит в узел заново с попыткой №1. Блок
прямо говорит, что это заметки, а не доказательство: сверять с `git status`/`git diff`.
Снимает черновик `route-runtime` только при **успешном** терминальном коммите узла
(`done`/`skipped`, плюс после успешной проверки bootstrap-записи SCOUT) — между заходами он
и нужен, а после закрытого узла стал бы чужими заметками для того, кто вернётся сюда
человеческим `goto`. На `failed` и `exhausted` черновик **остаётся**: узел не закрыт, маршрут
остановлен и передан человеку, узел будут переигрывать — и черновик тут единственная запись
остатка работы. Если TESTS отчитается «детали и остаток — t<TASK>.tests.checkpoint.md», а
движок сразу сотрёт файл, у остановленного маршрута останется одно предложение комментария
вместо разбора. После остановки «исчерпаны попытки» черновик остаётся до явного возврата
человеком и нового входа в тот же узел.

**Указание человека при возврате на узел.** Свободный человеческий текст доезжал до агента
только через решение ворот. У обычного узла канала не было: кнопка «перейти сюда» (`goto`,
событие `human-rewind`) писала причину в журнал попытки — и на этом всё, агент входил
с тем же заданием, что и в прошлый раз, и повторял ту же ошибку. Разбор приходилось
протаскивать через черновик хода, то есть мимо журнала. Теперь причина возврата
и есть указание: `attempt_stage_state_human_note_v2` читает из журнала последнее
`human-rewind` по узлу, `route_v2_dispatch_next` берёт его **один раз на вход в узел**
(журнал за время узла не меняется, а каждое чтение — обход всех событий под локом)
и отдаёт `run_agent` в `FACTORY_STAGE_HUMAN_NOTE`, а тот приписывает блок
**последним** — черновик выше зовёт «продолжай с этого места», а человек мог вернуть узел
ровно затем, чтобы с этого места свернуть; блок прямо объявляет, что при расхождении прав
человек. Указание живёт до первого коммита узла: повторы внутри захода его видят, а
следующий приход сюда (петля маршрута, возврат через полгода) — уже нет, иначе агент
получит чужой приказ и будет уверен, что человек велел это ему. Блок движковый, не
маршрутный, поэтому публикация каталога профиля не нужна.

Из-за этого пришлось поправить идемпотентность коммита. Она существует ради одного случая:
событие легло в журнал, процесс умер до того, как увидел успех, и повтор не должен положить
второе. Ключ — `lastCommit` (узел + исход), а он переживал `human-rewind`, и переигранный
узел с **прежним** исходом события не клал: курсор не двигался, диспетчер видел тот же узел
готовым и гонял по нему агента до потолка шагов. Человек жмёт «перейти сюда» как раз на
только что закрытом узле, так что путь основной. `prepare-commit` теперь пропускает
идемпотентность, если по узлу есть непогашенный `human-rewind`; после нового коммита узла
возврат перестаёт быть свежим, и настоящий переигрыш умершего процесса гасится как прежде.
Маршрутный `rewind` (отказ ворот) сюда не относится и не менялся: там `lastCommit` указывает
на сами ворота.

**Сигналы демону.** TERM/INT обрабатывает route launcher: сначала снимает собственный
trap, затем через trusted runner identity останавливает exact process group активного
узла и только после доказанной quiescence восстанавливает instrumentation. Если identity
или cleanup нельзя доказать, попытка получает `STALLED_HUMAN=1`, а baseline и shared lease
не освобождаются молча.

**Trusted identity раннера.** Публичная идентичность живого запуска — файл
`${FACTORY_CONTROL_ROOT}/runner-processes/t<TASK>.active` (SCHEMA=1, ровно 11 строк:
TASK/STAGE/RUN_ID/EPOCH/RUNNER/PID/PGID/SESSION/STARTTIME/STATE). Публикация требует
доказанной setsid-изоляции (`PID==PGID==SESSION`) и сверки с живым `/proc` по четырём
полям (pgid, session, starttime, state); каталог 700, файл 600, symlink запрещены.
`factory <task> runner switch` читает ТОЛЬКО этот файл — provider-writable `meta.env`
сохраняет PID/PGID/STARTTIME лишь как диагностику и перенаправить сигнал не может.
Гашение — всегда СЕССИЯ раннера целиком (TERM → CONT → grace → KILL по каждой
группе процессов сессии) с re-check идентичности. Порядок TERM → CONT, а не
наоборот: остановленному на барьере раннеру сигнал ставится в очередь и
доставляется в момент разморозки, иначе между CONT и TERM он успевает вызвать
provider CLI мимо барьера. На интервал fork → publish
сигналы TERM/INT откладываются и переигрываются после барьера. Граница именно
сессия, а не группа лидера: GNU `timeout` вокруг provider CLI делает себе
`setpgid`, поэтому дерево агента живёт в другой группе той же сессии — пока
проверка смотрела на группу лидера, «группа пуста» ложно доказывало тишину, и
launcher мог снять identity под живым агентом: claude, MCP и docker переживали TERM.
Собственная сессия под сигнал не попадает никогда.
Порядок проверок в `_runner_runtime_present` менять нельзя: сначала дешёвый
`kill -0` по группе лидера и только на пустой группе — скан сессии по `/proc`
(один форк awk, ~30 мс). Скан впереди `kill -0` стоил ~0,25 с на КАЖДЫЙ опрос, и
хвост этапа с циклами ожидания уезжал за секунды — так падал
`core-multi-runner` на границе human-stall. Цикл ожидания по той же причине
сначала спрашивает уже известные группы и платит за скан, лишь когда они
опустели. Коды: 73 — identity mismatch/чужой lock,
76 — не изолирован или живая чужая запись, 78 — повреждённое/небезопасное состояние.

**Скан сессии не имеет права молчать.** Файлы `/proc/<pid>/stat` открываются
внутри awk через `getline`, а не передаются ему в argv: процесс, исчезнувший
между globом и открытием, для awk (и gawk, и mawk) — «критическая ошибка», после
которой он обрывает обработку целиком и не печатает НИЧЕГО. Одного такого
процесса на живой машине хватало, чтобы скан объявил непустую сессию пустой, —
то есть ровно то ложное доказательство тишины, ради которого скан и написан.
При `getline` исчезнувший pid просто пропускается.

**Чтение и снятие identity.** Запись читается по ОДНОМУ открытому дескриптору:
доверие (владелец, права 600, ровно одна жёсткая ссылка) проверяется через
`stat -L /proc/self/fd/N`, содержимое берётся оттуда же. Через путь получалась
TOCTOU: `stat` подтверждал один inode, а `mapfile` читал другой, который
конкурентный publish уже подменил. Исчезновение записи — штатная часть протокола,
а не подмена: отсутствие файла и `nlink == 0` дают 3 («активной identity нет»),
78 остаётся за действительно недоверенным состоянием. Снятие идемпотентно —
уборщиков двое, launcher (раннер умер) и оператор (`runner switch` погасил того
же раннера), они регулярно встречаются на одной записи, и проигравший гонку
обязан отвечать успехом. Пока это считалось ошибкой, CLI отчитывался о провале
состоявшегося переключения, а launcher ловил `group_rc` и подменял результат
этапа на 76 (`core-multi-runner` краснел под нагрузкой 5 прогонов из 24).

## Бандлы маршрутов v2

Server публикует route и catalog как content-addressed каталоги
`revisions/<sha256(manifest)>`. Engine не доверяет HTTP-ответу или имени каталога:
`factory-route` повторно проверяет типы файлов, отсутствие symlink/лишних каталогов,
manifest/hash/size, строгую schema, достижимость, переходы, owner↔status и все prompt-ссылки.

Catalog содержит точные route hashes и bootstrap Scout. Рендерер принимает только JSON
context, проверяет обязательные корневые секции, отклоняет secret-shaped поля и добавляет
их как ограниченные hash-секции данных. Условия prompt-блоков поддерживают только
`context.path == JSON scalar`; произвольных выражений и shell нет. Golden-тест фиксирует
точный детерминированный core рендера. Run-specific команды `stage-result` и
`stage-progress` по-прежнему добавляет `multi-runner.sh` последним блоком непосредственно
перед запуском provider-а.

У каждого исполняемого узла `id` точно равен `runKey.toLowerCase()`, а `timeoutClass`
принадлежит известному движку набору. Наличие канонического `ship` включает
`delivery.mode=publish`; его отсутствие включает `disabled` и запрещает delivery-capability
в остальных узлах. Поэтому маршрут анализа может завершиться через собственный tail без
пустых targets или фиктивного SHIP.

`current.json` читается только при создании новой попытки. После pin все команды получают
явный `catalogHash`; route hash выбирается только из этого каталога. Единственный launcher
исполняет только опубликованные route bundles: legacy prompt hooks и fallback на профильные
массивы этапов удалены.

Trusted-журнал попыток отделён от отображаемой runtime-проекции `state/tNN.pipeline`:

```text
${FACTORY_CONTROL_ROOT}/protocol-v2/tasks/t<TASK>/
  protocol.json
  active-attempt.json
  attempts/a_<id>/
    attempt.json
    pins.json
    route-pin.<sha256>.json
    terminal.<sha256>.json
```

`attempt_state_begin_v2` один раз закрепляет catalog и bootstrap Scout,
`attempt_state_select_route_v2` один раз выбирает route только из этого catalog.
`resume` всегда перечитывает и проверяет закреплённые bundle, а не новый `current`.
Успешный `finish` разрешён только после route pin; `abandon` допустим и в bootstrap.
Recovery создаёт новую attempt с новым catalog pin и явной ссылкой на abandoned attempt.
Оператору обе операции доступны как `factory TASK abandon|recover --attempt …
--reason …` (recover дополнительно требует `--route` и сразу пинит его — попытка без
route pin была бы тупиком для resume); обе берут lock оркестратора задачи, поэтому
под живым foreground-прогоном получают отказ, а не режут попытку под ним.
Хранилище опубликованных бандлов по умолчанию — `~/.factory/routes`; сервер публикует
туда же через `COCKPIT_ROUTES_DIR`.

Ретраи исполняет доверенный рантайм по контракту бандла. Попытки без результата
повторяются в пределах суммы бюджетов `retry.noResult` и
`retry.providerFailure.attempts`: no-result и провайдерский сбой на этой границе
неразличимы, потому что multi-runner уже исчерпал failover-цепочку ВНУТРИ
`run_agent` (обязательный coverage из `runners.env` — это и есть runner-failover).
Committed `failed` повторяется только в пределах `productFailure`. Исчерпание
бюджета — синтетический исход `exhausted`, его вырабатывает рантайм, агент
сообщить его не может. Agent-узел с `parallel/N` допустим только при
`filesystem=state-only`: native-capable runner получает требование поднять N независимых
read-only ветвей, а `degrade=allow-single` разрешает runner-у без native fanout выполнить
их последовательно в одном запуске. `degrade=forbid` в таком случае останавливает попытку
fail-closed до запуска. `executor=command` исполняет только allowlisted hook профиля,
единожды и с `fanout=single`; shell из route bundle не исполняется. Пока не реализована
только стратегия повторов `same-runner`, она также отклоняется
`_route_v2_node_caps_guard` до запуска.
После runner-а и `state-only` guard диспетчер вызывает необязательный evidence hook профиля
с точным `runId`. Его отказ коммитится как продуктовый `failed`: это позволяет машине
остановить недоказанный coverage у человека без бессмысленного no-result retry.
Доверенный результат hook хранится под control-каталогом конкретной immutable attempt;
provider-writable файлы в `STATE_DIR` остаются только отображаемыми копиями. Так поздний узел
не может незаметно переписать уже принятую матрицу линзы, а новая попытка той же задачи не
подхватывает evidence предыдущей.
Active pointer меняется под kernel `flock` и compare-and-swap. `factory` принимает resume
только с exact immutable attempt; исторический реестр без такого pin остаётся read-only.
`FACTORY_CONTROL_ROOT` создаёт trusted host; provider adapters не получают его как
`--add-dir` или writable state root.

### Что заморожено, а что живое

В попытку замораживается только опубликованный bundle. Live-компоненты применяются по своим
границам и не становятся частью pin автоматически:

| Слой | Где лежит | Когда перечитывается |
|---|---|---|
| Движок | `engine/bin`, `engine/lib` | при каждом запуске процесса |
| Профиль | `profiles/<имя>/profile.sh` | перед каждым этапом (`_reload_profile`) |
| Runner policy | `profiles/<имя>/runners.env` | при каждом routing decision; во время активного прогона не менять |
| Server / web | `server/`, `web/` | после сборки и человеческого рестарта процесса |
| Исходник схемы | `profiles/<имя>/routes/` | сам по себе ни на что не влияет; нужен publish CAS |
| Схема (маршрут) | `~/.factory/routes/<профиль>/` | **никогда** — берётся по пину попытки |
| Состояние задачи | `state/tNN.*`, `protocol-v2/tasks/tNN/` | своё на задачу, кодом не управляется |

Публикацию делает `publish.mjs` профиля (или сервер). Она валидирует исходник, считает
sha256 всего бандла и кладёт его в `catalog/revisions/<хеш>/`. Хеш не назначается версией —
он ВЫЧИСЛЯЕТСЯ из содержимого: одинаковый исходник даёт тот же каталог и не плодит ревизию,
любая правка даёт другой каталог, а старый остаётся нетронутым. Ревизии не дублируют друг
друга по задачам и занимают только объём уникальных бандлов.

У публикации два независимых эффекта, и путать их не надо:

1. **новая ревизия** — это защита УЖЕ ИДУЩИХ попыток: их каталог никто не переписывает;
2. **сдвиг `current.json`** — это раскатка: с него новые попытки начнут брать новое.

Попытка не копирует схему себе, она записывает две ссылки: `pins.json` (`catalogHash`) и
`route-pin.<sha256>.json` (`routeId` + `routeHash` + `selectedAt`). Имя pin-файла — sha256
его собственного содержимого, поэтому подмена видна без обращения к чему-либо внешнему;
рядом лежат `pins.sha256` и `attempt.sha256` тем же приёмом. Дальше каждый узел читает
промпт из хранилища по этому пину, а каждый переход сверяется с `catalogHash` попытки и
отказывает при расхождении. Подменить схему под работающим прогоном нельзя даже намеренно.

Практические следствия, за которые уже платили временем:

- **правка схемы не догоняет запущенное.** Ни `resume`, ни `goto` каталог не перечитывают;
  `current.json` открывается только в режимах `check` и `start`. Хочешь новые промпты —
  нужна новая попытка, старой они не достанутся никогда;
- **`goto` дешевле, но остаётся на старой схеме.** Он двигает курсор ВНУТРИ попытки:
  сбрасывает целевой узел и весь хвост маршрута после него, сохраняя результаты пройденного
  начала. Годится, когда надо переиграть узел, а не проверить новую схему;
- **`recover` берёт текущий каталог, но начинает с чистого bootstrap.** Новая попытка пинит
  `current` в момент создания (`_attempt_state_create_locked` читает его сам) и наследует
  только ВХОДНЫЕ контракты предшественницы — ticket, delivery, scope, diagnosis. Результаты
  работы (`bootstrap.json`) намеренно не переносятся, поэтому цепочка идёт заново со SCOUT.
  Требует, чтобы предыдущая попытка была `abandoned`.
  Заодно `recover` **вычищает диск под новую попытку**: выходы этапов из namespace задачи
  (`<state>/t<TASK>.*`, кроме движковых `active/env/instrumentation/lock/orch.log/pipeline/
  pipeline.lock/route`) уезжают в `attempts/<предшественница>/state-artifacts/`
  (`attempt_state_quarantine_artifacts_v2`), а реестр переинициализируется в `pending`
  по узлам ЗАКРЕПЛЁННОГО маршрута новой попытки. Без этого «чистый bootstrap» врёт:
  CLI отказывается перезаписывать файл, который в этой сессии не читал, поэтому SCOUT может
  принять чужой `t<TASK>.recon.md` за свой и закрыть этап `done`, а PLAN — обойти отказ
  склейкой и приклеил к свежему плану хвост прошлой попытки с разделами
  SKEPTIC/TRANSLATOR/TCRITIC, а сам PLAN до этого прочитал в реестре `TESTS=done`
  от отменённой попытки и пошёл искать несуществующие тесты;
- **workspace mode закреплён в попытке.** В `isolated` профиль создаёт отдельные worktree и
  task-стенд своим `up.sh`; engine проверяет непересечение source/worktree. В `shared`
  source и workspace обязаны быть одним canonical primary checkout, а stand — заранее
  существующим внешним ресурсом. Engine не вызывает `up.sh`/`down.sh`, не создаёт и не
  удаляет worktree/container/volume и держит durable lease всех объявленных
  `profile/workspace/stand/gpu` ресурсов до completion или успешного `abandon`.

## Файловые политики

`state-only` контролируется exact before/after guard: HEAD, worktree,
index, tracked/untracked content, symlink targets и объявленные sensitive ignored-файлы.
Расхождение приводит к human stall; общего autorevert нет.

`transactional-write` предназначен для `trace → verify`: host заранее фиксирует file scope,
проверяет отсутствие изменений вне него, сохраняет ожидаемый checkpoint и при cleanup
восстанавливает только transaction-owned файлы. Несовпавший CAS оставляет чужую правку
нетронутой и останавливает попытку.

Guard не заменяет host sandbox. Рабочий запуск `state-only` запрещён, пока выбранный
runner физически сохраняет source roots writable.

Для Claude trust boundary закреплён за audited native CLI `2.1.220`: runner принимает только
owner-only `0400` settings из `CONTROL_DIR`, а сам control tree помещает в tool-level
`Read/Edit/Write/NotebookEdit` deny. CLI запускается с пустым `--setting-sources`,
`--safe-mode`, `--strict-mcp-config` без MCP config и `--disable-slash-commands`; `--bare` не
используется, поэтому штатная OAuth/keychain авторизация сохраняется. Неаудированная версия
Claude fail-closed недоступна route engine.

**Native OS sandbox временно снят — и вот почему.** Обязательный блок
`"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,…}`
в engine-owned settings на Linux означает bwrap, то есть user namespace, где отображены
только uid/gid запускающего. Следствий два, и оба смертельны для рантайм-этапов:
дополнительные группы теряются, поэтому `/var/run/docker.sock` (`root:docker 0660`) виден
агенту как `nobody:nogroup` и недоступен; сеть уходит в свой namespace, поэтому порт стенда
на хостовом localhost отвечает «в соединении отказано». Рантайм-этапы ходят в стенд ровно
этими двумя каналами. На t7802 это выглядело как провал REPRO с пустым результатом: агент
прочитал код и записал гипотезу, но не снял ни одного объективного сигнала, а
`allowUnsandboxedCommands:false` закрывал и escape-hatch (`dangerouslyDisableSandbox`).
Читающие узлы (SCOUT) при этом проходили, поэтому регрессия и не была видна сразу.

Обратно границу можно вернуть только вместе с каналом до стенда:
- прокси перед `docker.sock` от своего uid + `allowAllUnixSockets` (per-path
  `allowUnixSockets` в этом CLI — macOS-only, seccomp не фильтрует по пути), заодно сузив
  API до контейнеров своей задачи; доступ к порту стенда снаружи придётся заменить на
  `docker exec … curl` изнутри контейнера, либо разбирать `allowedDomains`-прокси;
- либо sandbox по классу узла из бандла маршрута: жёсткий для `state-only`, снятый для
  рантайм-классов.

Пока этого нет, раннер не заявляет capability `sandbox`. Валидатор settings при этом
сохранён наполовину: блока `sandbox` может не быть вовсе, но если он объявлен — обязан быть
прежней аудированной формой (hard-fail при недоступности, без `excludedCommands` и
`allowRead`). Имитация границы хуже её честного отсутствия. Тест
`tests/engine/unit/route-agent-permissions.sh` падает при возврате блока — это напоминание
вернуть канал вместе с ним.

Restricted Codex для shared stand не наследует writable control root и не включает network
proxy. Exact `PROFILE_AGENT_CONTROL_DIR` проверяется как canonical owner-only directory mode
`0700`, не пересекающийся с writable `--add-dir`, и добавляется в permission profile только
как `read`. Профиль Rdesigner использует внутри две FIFO `0600` и regular lock `0400`:
проверенный Codex 0.145 на Linux умеет открывать FIFO на запись и брать `flock` через такой
read-only bind. Командный sandbox поэтому работает с `network.enabled=false`; localhost/TCP,
AF_UNIX и Docker socket в agent transport отсутствуют.

**Обёртки команд в deny-листе.** Разрешения раннера сверяются по ПРЕФИКСУ строки, поэтому
любой запускатель отмывает запрет: `timeout git commit …` не совпадает с `Bash(git commit:*)`
и проходит как `Bash(timeout:*)`. На проверочных этапах `_agent_settings` поэтому запрещает
сами обёртки (`timeout`, `env`, `xargs`, `nohup`, `setsid`, `stdbuf`, `nice`, `sudo`,
`sh -c`, `bash -c`) рядом с встроенными интерпретаторами. Это существеннее, чем кажется:
раньше файл этапа ложился поверх личных настроек человека, где `Bash(timeout:*)` мог быть
разрешён «для себя». Claude route runner теперь полностью отключает эти setting sources;
engine-owned deny остаётся самостоятельной политикой. Добавляя обёртку в этот список,
проверяй, не пользуется ли ею сам профиль: запрет действует и на его скрипты.

В `isolated` инструментационная транзакция требует отдельный linked worktree,
эксклюзивно арендованный trusted host-ом. В `shared` primary checkout допустим только при
точно проверенном durable lease всех workspace/stand ресурсов. Lease остаётся занят до
полного cleanup; после восстановления scope профиль обязан синхронизировать существующий
stand и подтвердить health. Ошибка cleanup или post-restore оставляет попытку и lease в
human stall — автоматического освобождения поверх изменённого checkout нет.

**Что попадает в снимок.** Чувствительный список транзакции — это `scope.list`, и только он:
записи по нему нужны cleanup-у, чтобы доказать побайтовое восстановление инструментации.
Правки исходников ловятся не через него — записи `TRACKED_WORKTREE`, `TRACKED_INDEX` и
`UNTRACKED` `workspace_guard` строит прямо из состояния git.

Раньше сюда добавлялись ВСЕ игнорируемые git файлы каждого корня — `node_modules`, `vendor`
и прочий рантайм целиком, в крупном проекте десятки тысяч путей. Это стоило дорого и не
защищало: см. «Почему игнорируемые файлы сняты с наблюдения» ниже. Побочный эффект отмены —
снимок из 72 778 путей превратился в десятки, а он берётся ЧЕТЫРЕЖДЫ за транзакцию (baseline,
checkpoint и дважды в cleanup). Оптимизация, ради которой сбор записей переписывали на один
процесс python (`_workspace_guard_batch_records`, 19 минут → 2 секунды), стала запасом
прочности, а не необходимостью — но выбрасывать её не нужно.

Формат записи при этом обязан оставаться байт-в-байт прежним: снимки сравниваются `cmp`, и
baseline, снятый прошлой версией движка, должен сойтись с checkpoint новой — иначе перезапуск
демона посреди открытой транзакции выдаст ложное нарушение readonly и убьёт живой прогон.
Поэтому sha256, base64 и восьмеричный режим считаются так же, как их считали `sha256sum`,
`base64 -w0` и `stat -c '%a'`, а ветка «ни файл, ни symlink» по-прежнему зовёт
`stat -c '%F:%s:%Y'`: его текст переводится локалью и в python не воспроизводится. Меняя эту
функцию, сверяйся с прежней реализацией на фикстуре со всеми видами записей, а не только
тестом «снимок поймал правку». Нечитаемый файл даёт пустое поле хеша, а не провал снимка:
контейнеры стенда пишут в рабочее дерево от своего пользователя, и прежний конвейер
`sha256sum | awk` вёл себя ровно так же (код возврата брался у `awk`).

**Почему игнорируемые файлы сняты с наблюдения.** Замысел был такой: следить за всем, что
git игнорирует, — иначе агент спрячет правку в `.env`, `vendor` или `node_modules`. На деле
это не защищало и стоило прогонов.

Не защищало, потому что сторож сравнивает ДВЕ ТОЧКИ — `begin` и `checkpoint`. Всё, что
изменили и вернули между ними, для него не существует: чтобы обойти надзор, достаточно
откатить `.env` перед завершением этапа. Ловилась только небрежность, не намерение.

Стоило, потому что стенд поднят всю транзакцию — узел вроде `TRACE` ради живого прогона и
существует, — а его мусор сторожу неотличим от правки: файл был другой, значит кто-то менял.
Приёмка t8165 встала на 177 дампах `storage/debugbar` и трассах Playwright, без единого
исходника. Список исключений `PROFILE_VOLATILE_PATHS` эту дыру не закрывал, а лишь
регистрировал прошлые попадания: в нём оказывалось ровно то, на чём уже умер прогон, тогда
как следующая мина всегда лежала взведённой — `node_modules/.vite` (128 файлов), `.vite-temp`,
`.vue-global-types`, и внести их было нельзя, `node_modules` в списке запрещали намеренно.
Перечислением инструменты не догнать.

Замер на t7802 показал, что именно охранялось. У `.env`, `storage`, `node_modules` и кэша
Vite — `nlink=1`: это копии песочницы, они исчезают вместе с ней и в диф не попадают никогда.
Исключением был только `vendor` бэкенда с `nlink=7`, потому что профиль клонировал его через
`cp -al`: запись в одной песочнице меняла файлы основного репозитория и шести соседних
деревьев разом (pest писал туда кэш и уронил чужую транзакцию). Это дефект провижна, а не
предмет надзора, и лечится он в профиле полной копией — требование «самодостаточное рабочее
дерево, без общих inode» теперь записано в PROFILE-CONTRACT.

Итог: игнорируемые файлы в чувствительное множество не попадают, `PROFILE_VOLATILE_PATHS`
и `volatile.list` отменены целиком. Половина сторожа, которая несёт нагрузку, не тронута —
доказать, что инструментация снята и в диф не уехало лишнего, он по-прежнему обязан.

**У `stalled` нет автоматического восстановления, и это намеренно.** Checkpoint или cleanup,
увидевший чужое изменение, пишет durable `STATE=stalled` с `REASON` (`out_of_scope_change`,
`unsafe_scope_object`, `snapshot_failed`, `cleanup_snapshot_failed`, `concurrent_change`,
`cleanup_resume_conflict`, `restore_failed`, `baseline_not_restored`) и
возвращает 75; диспетчер валится fail-closed, демон уходит, узел остаётся незакрытым.
Разбирать такое обязан человек: движок не знает, чья это правка. Чтобы разбор не начинался
с base64 в снимках, `_route_v2_log_transaction_stall` пишет в журнал причину и сводку
`workspace_guard_diff_paths` — тип записи и каталог с числом файлов, без содержимого.
`resume` вставшую транзакцию не подхватывает: `route_v2_cleanup_active_instrumentation`
знает только `active`, `cleaning` и `completed`, на `stalled` возвращает 75 — демон
поднимется и тут же умрёт, пока человек не разберёт.

**Как расшить вставшую транзакцию** (`<TX>` — `~/.factory/control/transactions/t<TASK>/<txid>`):

1. Убедиться, что демон мёртв: `systemctl --user is-active factory-t<TASK>.service`.
2. Прочитать `<TX>/state.env` — `REASON` называет вид расхождения, а
   `workspace_guard_diff_paths <TX>/baseline.tsv <TX>/checkpoint-1.tsv 12` показывает, где.
3. Сверить файлы scope с бэкапами: `<TX>/files.tsv` даёт пары «путь → `backups/<хеш>.data»
   (пути в base64). Совпали побайтово — инструментация уже снята, восстанавливать нечего;
   разошлись — вернуть файл из бэкапа, это и есть ручной cleanup.
4. Убрать транзакцию из-под ног: `mv <TX> <TX-родитель>/.stalled-<метка>` и удалить
   `active.env`. Именно `mv`, а не `rm`: бэкапы и снимки — единственная улика.
   **Каталог обязан перестать совпадать с txid.** Идентификатор — `v2-<attempt>-s<sequence>`
   от курсора ленты, а провалившийся узел в ленту ничего не записал, поэтому повтор возьмёт
   ТОТ ЖЕ txid, а `instrumentation_tx_begin` при существующем каталоге отдаёт 73.
5. Проверить, что маркер этапа не остался в дереве (`grep -r FACTORY-TRACE:t<TASK>`) —
   иначе `begin` откажет снова, уже с кодом 78.
6. Поднять демона обычным `resume`; узел пойдёт заново с чистого baseline.

Менять состав снимка под уже вставшей транзакцией бесполезно и вредно: её `baseline.tsv`
снят прежним кодом, и новый checkpoint разойдётся с ним на ОТСУТСТВИИ записей, которых
теперь не пишут. Поэтому шаг 4 — вынести транзакцию, а не чинить её на месте.

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

Новый провайдер добавляется по [ADDING-RUNNER.md](ADDING-RUNNER.md): контракт адаптера,
fail-closed classify, TDD-порядок с критикой тестов, live-допуск.

## Status protocol

Транспорт статуса двухпутевой: fd 7 с capability-токеном — быстрый путь, deferred
`status_request` (файл-запрос в `control-requests/`, применяет runner-launcher вне
песочницы) — обязательный резерв. Оба заявляют и Codex, и Claude: начиная с
CLI 2.1.220 Claude не наследует fd 7 в тул-шелл агента, из-за чего Scout не может
отчитаться; `stage-result.sh` сам выбирает доступный путь.

`run_state_begin` атомарно:

- увеличивает epoch;
- создаёт active run record;
- сохраняет hash capability;
- выставляет stage `running`.

Capability передаётся adapter-у через FD, а не argv/env/prompt.

Статус `running` появляется РАНЬШЕ этого момента: маршрутный рантайм помечает узел на входе
(`_route_v2_mark_node_running`), до рендера промпта, открытия транзакции и снимка рабочих
деревьев, и пишет в журнал строку «узел N: подготовка к исполнению». Пометка трогает
только колонку статуса; владение запуском по-прежнему выдаёт исключительно `run_state_begin`
со своим epoch и capability, поэтому вторая запись `running` — не конкурент, а уточнение.
Без пометки доска показывает прошлый узел всю подготовку, и человек читает это как
«конвейер встал». Явная projection-запись восстановила эту семантику после перехода
на route dispatcher.

`stage-result` проверяет:

- активный task/stage;
- точный `run_id`;
- точный `epoch`;
- capability hash;
- состояние `active`;
- точную схему typed verdict: owner из закрытого набора и непустой список findings
  с каноническими стабильными id. Legacy `failed` без verdict остаётся допустимым только
  для совместимости со старыми маршрутами.

Повторный или поздний terminal result возвращает конфликт и не меняет новый run.

`stage-progress` выполняет те же проверки и дополнительно применяет allowlist ключей/значений.
Он никогда не завершает текущий stage.

`pipeline-set.sh` не входит в agent permissions и не владеет инициализацией, topology,
lifecycle, provenance, route status или route comments. Эти записи проходят только через
host/control writer либо run-scoped capability API. Immutable attempt ledger остаётся
источником истины даже при повреждении отображаемой проекции.

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

Основной route не архивирует реестр. `bin/factory` сначала завершает `SHIP`, затем `RETRO`,
проверяет оба terminal status и только после этого переносит карточку в archive. Ошибка
хвоста оставляет active registry для безопасного resume.

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

## Историческое состояние

Legacy registry можно читать или отдельно архивировать, но единый `factory` никогда не
исполняет и не возобновляет его. Resume требует exact immutable attempt из trusted control
root; одного старого `RUN_PROTOCOL=2` недостаточно (legacy launcher тоже писал этот маркер).
Автоматического мигратора, compatibility wrapper или пути назад в удалённый legacy-цикл нет.

## Как проверять изменения

Сначала targeted test, затем полный suite:

```bash
rg -l -0 '^#!/usr/bin/env bash' engine/bin engine/lib profiles | xargs -0 bash -n
python3 -m py_compile engine/lib/dashboard.py
engine/bin/factory-check --quick
tests/run-all.sh
```

Тесты располагаются только в корневом `tests/`, документация — только в корневом `docs/`.
Новые `engine/tests` и `engine/docs` не создавать.

Offline-набор движка идёт параллельно: `tests/engine/run-offline.sh` запускает сам себя
по одному файлу на процесс (`xargs -P`, по умолчанию `nproc`, переопределяется
`TEST_JOBS=1` для последовательного разбора). Изоляция та же, что и была: у каждого файла
свой `TEST_ROOT`/`STATE_DIR` и `env -i`, вывод файла печатается одним блоком под общим
`flock`, поэтому порядок файлов в выводе плавает, а строки не перемешиваются. Отсюда
требование к новым тестам: не полагаться на порядок между файлами и не считать процессы,
группы и содержимое `/proc` за пределами своего поддерева — соседний файл в это же время
делает то же самое. Общее время набора теперь равно самому долгому файлу, а не сумме.

Host preflight запускается отдельно и явно:

```bash
RUN_HOST_PREFLIGHT=1 engine/bin/factory-check --host-preflight
```

Он допускается после offline suite, но до Cockpit/рабочего запуска. Реальный model call не является
частью автоматического test suite.

## Когда изменение вступает в силу

- `profile.sh` перечитывается перед этапом;
- `runners.env` читается при каждом routing decision;
- task override читается из pipeline;
- server/web код требует обычного рестарта соответствующего процесса;
- уже запущенная provider attempt не меняет модель посередине; switch создаёт новую attempt;
- промпты и схема v2 требуют публикации И новой попытки: примороженный бандл не меняется
  ни от `resume`, ни от `goto` — см. [Что заморожено, а что живое](#что-заморожено-а-что-живое).

Отсюда типичная ошибка при разборе прогона: правку внесли, задачу перезапустили `resume`,
поведение не изменилось — и правку начинают считать неработающей. Сначала ответь, какой это
слой. Движок и профиль подхватятся на следующем же этапе; схема — только следующей попыткой.

**Но `bin/factory` при живом прогоне не править вообще.** Демон — это и есть исполняемый
`bin/factory`, а bash читает скрипт лениво, по сохранённому смещению в файле. Правка сдвигает
всё, что ниже: демон дочитывает следующую команду уже с чужого места и умирает синтаксической
ошибкой в строке, которой в исходнике нет. Момент случайный — от «сразу» до «через час», когда
управление дойдёт до непрочитанного куска. В t7802 демону дописали 51 строку под ногами, и он
упал с `exit 2` вместо штатного fail-closed `75`, оборвав разбор на полпути; `bash -n` при этом
был чист, потому что на диске файл корректен. Правишь движок — сначала дождись конца прогона
или сними его `abandon`. Библиотеки в `lib/` этой ловушке не подвержены: они `source`-ятся
целиком до начала работы.
