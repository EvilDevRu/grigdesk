# Устройство Factory Engine

Документ для изменений в `engine/`. Контракт проекта описан в
[PROFILE-CONTRACT.md](PROFILE-CONTRACT.md), создание нового профиля — в
[NEW-PROJECT.md](NEW-PROJECT.md), multi-AI cutover — в [CODEX.md](CODEX.md).

## Инварианты

1. Движок не содержит имён контейнеров, БД, репозиториев и команд конкретного проекта.
2. Каждый локально установленный профиль имеет валидный `profiles/<name>/runners.env`;
   `/profiles/` не отслеживается Git, implicit provider отсутствует.
3. Агент не пишет pipeline напрямую. Terminal result идёт через run-scoped `stage-result`,
   разрешённый progress — через `stage-progress`.
4. Любой повтор/switch получает новый `run_id`, больший `epoch` и новую capability.
5. Автоматический failover выполняется только для классифицированных provider failures.
6. Config/state writers используют `flock`, CAS/revision и atomic rename.
7. Offline tests не запускают Cockpit и не выполняют model call.
8. Опубликованный route v2 bundle проверяется engine независимо от server-а; изменение
   `current` не меняет уже закреплённую ревизию.
9. Model/provider/effort отсутствуют в route schema и остаются только в `runners.env`.
10. Guard, locks, capabilities и состояние v2 лежат в `FACTORY_CONTROL_ROOT`, который
    не пересекается с provider-writable `STATE_DIR`.

## Карта

| Путь | Ответственность |
|---|---|
| `bin/factory` | CLI, start/resume/demo, обязательные config/protocol gates |
| `bin/factory-check` | profile contract и metadata-only host preflight |
| `bin/factory-new` | полный скелет `profiles/<name>/` |
| `bin/factory-migrate-v2` | backup и разовая миграция task state |
| `bin/factory-route-v2` | offline integrity check, typed prompt render и transition lookup |
| `bin/factory-v2` | foreground launcher протокола route v2: check/start/resume/gate/abandon/recover |
| `bin/factory-context-v2` | сборка typed JSON-контекста узла (провайдер-нейтральная) |
| `lib/core.sh` | stage loop, gates, retries, readonly guard |
| `lib/route-runtime-v2.sh` | доверенный диспетчер узла v2: pin, рендер, политика ФС, ретраи, exhausted |
| `lib/attempt-stage-state.sh` | курсор исполнения и append-only hash-chained журнал попытки |
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
| `lib/pipeline-set.sh` | process-level pipeline writer |
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

**Адрес стенда в контексте.** `services.frontendUrl`/`apiUrl` собирает `factory-context-v2`
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
(`policy.timeoutClass`), с переопределением профилем и legacy-путём по имени этапа —
порядок разрешения и таблица дефолтов в [PROFILE-CONTRACT.md](PROFILE-CONTRACT.md).
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
Снимает черновик `route-runtime-v2` только при **успешном** терминальном коммите узла
(`done`/`skipped`, плюс после успешной проверки bootstrap-записи SCOUT) — между заходами он
и нужен, а после закрытого узла стал бы чужими заметками для того, кто вернётся сюда
человеческим `goto`. На `failed` и `exhausted` черновик **остаётся**: узел не закрыт, маршрут
остановлен и передан человеку, узел будут переигрывать — и черновик тут единственная запись
остатка работы. Если TESTS отчитается «детали и остаток — t<TASK>.tests.checkpoint.md», а
движок сразу сотрёт файл, у остановленного маршрута останется одно предложение комментария
вместо разбора. То же правило в legacy-рантайме (`run_stage`); из остановки
«3 попытки без результата» черновик
выживал и раньше — задачу оттуда поднимает человек и возвращает в тот же узел.

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

**Сигналы демону.** TERM/INT в `run_pipeline` пишут причину в журнал этапов и уводят
за собой текущего агента: без `pkill` он доживает сиротой за умершим демоном. Цель
pkill — `$BASHPID`, а НЕ `$$`: в сабшелле (фон, конвейер, `$( )`) `$$` остаётся PID-ом
родителя, и обработчик шлёт TERM сам себе — входит в себя заново, молотит журнал
тысячами строк и не выходит вовсе (так `core-multi-runner` висел 122 с на одном
сценарии). `trap - СИГНАЛ` первой командой обработчика: повторный сигнал не запускает
его поверх уже идущего.

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
`factory-route-v2` повторно проверяет типы файлов, отсутствие symlink/лишних каталогов,
manifest/hash/size, строгую schema, достижимость, переходы, owner↔status и все prompt-ссылки.

Catalog содержит точные route hashes и bootstrap Scout. Рендерер принимает только JSON
context, проверяет обязательные корневые секции, отклоняет secret-shaped поля и добавляет
их как ограниченные hash-секции данных. Условия prompt-блоков поддерживают только
`context.path == JSON scalar`; произвольных выражений и shell нет. Golden-тест фиксирует
точный детерминированный core рендера. Run-specific команды `stage-result` и
`stage-progress` по-прежнему добавляет `multi-runner.sh` последним блоком непосредственно
перед запуском provider-а.

`current.json` читается только при создании новой попытки. После pin все команды получают
явный `catalogHash`; route hash выбирается только из этого каталога. Legacy
`profile_stage_prompt` пока остаётся активным для v1-профилей. Наличие v2 store само по себе
не включает cutover.

Состояние v2 не смешивается с legacy `tNN.pipeline`:

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
Оператору обе операции доступны как `factory-v2 TASK abandon|recover --attempt …
--reason …` (recover дополнительно требует `--route` и сразу пинит его — попытка без
route pin была бы тупиком для resume); обе берут lock оркестратора задачи, поэтому
под живым foreground-прогоном получают отказ, а не режут попытку под ним.
Хранилище опубликованных бандлов по умолчанию — `~/.factory/routes` (имя без
поколения: legacy маршрутов в `~/.factory` никогда не было, каталог принадлежит
только v2-store; сервер публикует туда же через `COCKPIT_ROUTES_V2_DIR`).

Ретраи исполняет доверенный рантайм по контракту бандла. Попытки без результата
повторяются в пределах суммы бюджетов `retry.noResult` и
`retry.providerFailure.attempts`: no-result и провайдерский сбой на этой границе
неразличимы, потому что multi-runner уже исчерпал failover-цепочку ВНУТРИ
`run_agent` (обязательный coverage из `runners.env` — это и есть runner-failover).
Committed `failed` повторяется только в пределах `productFailure`. Исчерпание
бюджета — синтетический исход `exhausted`, его вырабатывает рантайм, агент
сообщить его не может. Всё описанное бандлом, но не реализованное — parallel
fanout, стратегия same-runner, `executor=command` — останавливает попытку
fail-closed ДО запуска агента (`_route_v2_node_caps_guard`); до реализации веера
публикуемые бандлы держат `fanout: single/1`.
Active pointer меняется под kernel `flock` и compare-and-swap. До отдельного cutover
`factory` этот namespace не читает, поэтому v1 resume продолжает работать без двусмысленности.
`FACTORY_CONTROL_ROOT` создаёт trusted host; provider adapters не получают его как
`--add-dir` или writable state root.

### Что заморожено, а что живое

Схема — единственный слой, который замораживается. Остальные три читаются свежими:

| Слой | Где лежит | Когда перечитывается |
|---|---|---|
| Движок | `engine/bin`, `engine/lib` | при каждом запуске процесса |
| Профиль | `profiles/<имя>/` | перед каждым этапом (`_reload_profile`) |
| Схема (маршрут) | `~/.factory/routes/<профиль>/` | **никогда** — берётся по пину попытки |
| Состояние задачи | `state-v2/tNN.*`, `protocol-v2/tasks/tNN/` | своё на задачу, кодом не управляется |

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
- **песочница переживает смену попытки.** `v2_sandbox_up` зовёт `up.sh` профиля только при
  состоянии `absent`; при `ready` он не делает ничего. Значит новая попытка приходит в ТОТ ЖЕ
  worktree с результатами прошлой — если нужен честный прогон с нуля, стенд сносится отдельно
  и осознанно, а несохранённая работа при этом теряется.

## Файловые политики

`state-only` в legacy runtime контролируется exact before/after guard: HEAD, worktree,
index, tracked/untracked content, symlink targets и объявленные sensitive ignored-файлы.
Расхождение приводит к human stall; общего autorevert нет.

`transactional-write` предназначен для `trace → verify`: host заранее фиксирует file scope,
проверяет отсутствие изменений вне него, сохраняет ожидаемый checkpoint и при cleanup
восстанавливает только transaction-owned файлы. Несовпавший CAS оставляет чужую правку
нетронутой и останавливает попытку.

Guard не заменяет host sandbox. Рабочий запуск `state-only` запрещён, пока выбранный
runner физически сохраняет source roots writable.

**Обёртки команд в deny-листе.** Разрешения раннера сверяются по ПРЕФИКСУ строки, поэтому
любой запускатель отмывает запрет: `timeout git commit …` не совпадает с `Bash(git commit:*)`
и проходит как `Bash(timeout:*)`. На проверочных этапах `_agent_settings` поэтому запрещает
сами обёртки (`timeout`, `env`, `xargs`, `nohup`, `setsid`, `stdbuf`, `nice`, `sudo`,
`sh -c`, `bash -c`) рядом с встроенными интерпретаторами. Это существеннее, чем кажется:
файл этапа ложится ПОВЕРХ личных настроек человека, а там `Bash(timeout:*)` вполне может
быть разрешён «для себя» — и тогда дырка открыта на каждом проекте сразу. Deny сильнее
allow, так что запрет движка личную настройку перебивает. Добавляя обёртку в этот список,
проверяй, не пользуется ли ею сам профиль: запрет действует и на его скрипты.

Инструментационная транзакция дополнительно требует отдельный linked worktree,
эксклюзивно арендованный trusted host-ом. Обычный checkout и одно лишь значение переменной
окружения не считаются достаточной изоляцией.

**Цена снимка и почему его формат нельзя менять.** Чувствительный список транзакции — это
`scope.list` плюс ВСЕ игнорируемые git файлы каждого корня, то есть `node_modules`, `vendor`
и прочий рантайм целиком — в крупном проекте это десятки тысяч путей. Пока записи собирались по файлу
(git rev-parse на корень, stat, sha256sum, два base64 — 5-6 процессов на файл), снимок шёл
19 минут, а он берётся ЧЕТЫРЕЖДЫ за транзакцию: baseline, checkpoint и дважды в cleanup.
Сейчас записи собирает один процесс python на весь список (`_workspace_guard_batch_records`),
те же 72 778 путей — 2 секунды.

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

**Мусор работающего стенда.** Сторожу он неотличим от правки агента: файл был другой —
значит кто-то менял. А стенд поднят всю транзакцию, потому что узел вроде `TRACE` ради
живого прогона и существует: сторож может встать fail-closed на сотнях файлов
`storage/debugbar`, одном `storage/logs` и трёх артефактах Playwright — исходников среди
них не было ни одного. Ускорение снимка окно сузило, но закрыть его не может: запуск
приложения идёт ВНУТРИ транзакции. Какие пути изменчивы, знает только проект, поэтому
список объявляет профиль (`PROFILE_VOLATILE_PATHS`, см. PROFILE-CONTRACT), а движок
выбрасывает совпавшее до попадания в чувствительное множество. Список замораживается в
`volatile.list` рядом с `roots.list` при `begin` — по той же причине байт-в-байт: профиль
между заходами могли и поправить. Транзакции без этого файла читаются как «изменчивых
путей нет».

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

1. Убедиться, что демон мёртв: `systemctl --user is-active factory-v2-t<TASK>.service`.
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

Правка `volatile.list` уже вставшей транзакции не спасает — её baseline снят без фильтра,
и новый checkpoint разойдётся с ним на ОТСУТСТВИИ тех же записей. Поэтому шаг 4, а не
попытка починить транзакцию на месте.

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
деревьев, и пишет в журнал строку «узел N: подготовка к запуску агента». Пометка трогает
только колонку статуса; владение запуском по-прежнему выдаёт исключительно `run_state_begin`
со своим epoch и capability, поэтому вторая запись `running` — не конкурент, а уточнение.
Без пометки доска показывает прошлый узел всю подготовку, и человек читает это как
«конвейер встал». v1 делал так же (`run_stage`), v2 потерял
это, когда диспетчером стал маршрутный рантайм.

`stage-result` проверяет:

- активный task/stage;
- точный `run_id`;
- точный `epoch`;
- capability hash;
- состояние `active`.

Повторный или поздний terminal result возвращает конфликт и не меняет новый run.

`stage-progress` выполняет те же проверки и дополнительно применяет allowlist ключей/значений.
Он никогда не завершает текущий stage.

`pipeline-set.sh` не входит в agent permissions. Terminal значения protocol v2 через него
отклоняются как дополнительный защитный слой.

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

## Миграция состояния

Перед миграцией:

```bash
engine/bin/factory-migrate-v2 --dry-run
```

Рабочий запуск:

```bash
engine/bin/factory-migrate-v2
```

Мигратор:

- прекращает работу до записи, если найден живой orchestrator;
- валидирует profile config всех изменяемых задач;
- копирует исходные pipeline в timestamped backup;
- атомарно добавляет `RUN_PROTOCOL=2`;
- переносит fixed markers и malformed pipeline files в backup;
- пишет `manifest.tsv`;
- повторно запускается без изменений.

## Как проверять изменения

Сначала targeted test, затем полный suite:

```bash
rg -l -0 '^#!/usr/bin/env bash' engine/bin engine/lib profiles | xargs -0 bash -n
python3 -m py_compile engine/lib/dashboard.py engine/bin/factory-graph-new
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
