# DeepSeek Harness в GrigDesk: контракт и статус внедрения

Metadata helper относится к provider и сохраняет offline-отказ 126; см.
[границу offline executor](../grigdesk/pipeline/deepseek-offline-guard.md).

GrigDesk содержит выбранные исходники Harness `0.1.5-rc.2`, upstream commit
`c291e7961a515f6d7af9304e7fd1d257929aef26`. Независимый пакет `deepseek/` собирает самодостаточный ELF;
его установка отделена от подготовки сервера. Generic-контракт раннера:
[ADDING-RUNNER.md](ADDING-RUNNER.md).

Настоящий compiled runtime проверен с loopback API: web RPC/events для чата,
ACP для Factory, native settings обоих consumers, sandbox, MCP/status, hooks,
cancel/resume, обновление и совместимый откат. Эти проверки не расходуют платный API.
Состав и ограничения: [композиция](../grigdesk/chat/deepseek-vendored-composition.md),
[чатовый паритет](../grigdesk/chat/deepseek-compiled-chat-parity.md),
[настройки Factory](../grigdesk/pipeline/deepseek-native-settings-runtime.md),
[переход updater](../grigdesk/server/deepseek-binary-update.md).

Инструкция оператора по установке, режимам и откату:
[guide/deepseek.md](../grigdesk/guide/deepseek.md).

Текущий способ доставки — независимый `bin/deepseek` с bundled Node. Resolver и Factory
не выбирают stock `dsh`, `installed` или `embedded`; явный override тоже проходит metadata.
Установка/откат ELF выполняются отдельно, GrigDesk update сохраняет его bytes, cache и homes.
`grigdesk-ctl deps/run/dev` проверяют наличие без сборки Harness. Подробнее:
[contract 2 и readiness](../grigdesk/server/deepseek-binary-update.md).

## Реализация GrigDesk и Factory

Chat adapter живёт в `server/src/lib/executors/deepseek.ts`. Он запускает pinned DSH через
web RPC/events, строит private overlay/hooks на каждый ход, хранит session binding только
на сервере и возобновляет сессию лишь для того же realpath cwd, auth profile и security
profile. Metadata-каталог делает `initialize → session/new → session/close` без prompt;
opaque model id не разбираются и не переименовываются.

Factory adapter — `engine/lib/runners/deepseek.sh`. Prompt передаётся private-файлом, а не
argv. Host wrapper `server/scripts/deepseekRunner.mts` использует тот же runtime и отдаёт
`stage_progress`/`stage_result` через отдельный `deepseekStatusMcp.mts`; server-owned
run identity нельзя передать или подменить tool arguments. Provider credential не входит
в MCP env, retained event stream или launcher argv. Text-only успех без terminal status
повышается launcher-ом до protocol failure.

Runner различает поставки наблюдаемой версией с полным packageId, проверяет её
перед каждым узлом и публикует четыре opaque model id, capabilities
`status status_request tools structured_output` и не заявляет sandbox/fanout только по
факту наличия upstream-механизма. Billing dialect намеренно не зарегистрирован: usage
Factory остаётся `unavailable`. Автоматический failover разрешён только для доказанного
invalid-key до model/tool activity; timeout различим отдельно, все неоднозначные исходы
остаются `unknown`.

Binary-ветка использует тот же async descriptor, что чат, с явным cache-dir и полным
packageId в observed coverage version. Замена ELF после prefs отклоняется подготовленным
handle до ACP/prompt. Реальные binary Factory native/status проверки и устройство —
[в контракте бинарной Factory](../grigdesk/pipeline/deepseek-binary-factory.md).

## Исторический аудит внешнего npm-артефакта

Следующие сведения и live fixtures описывают первоначальную интеграцию внешнего
`@deepseek-ai/dsh@0.1.5-rc.2`. Они сохраняют происхождение исходных протокольных
наблюдений; текущий автономный runtime доказывается отдельными binary compiled тестами выше.
Обезличенные трассы лежат в `tests/fixtures/deepseek-harness/`, с manifest происхождения.

Проверено на Node `v22.22.1`:

- npm-версия: `0.1.5-rc.2`; `bin.dsh = lib/bin.js`;
- integrity из установленного `package-lock.json`:
  `sha512-8Xc8hCQHcIWRmTCVU/xZdp6/qMsWMeAd2ObChKDEsfhUPJFXx6H0lgeb1DxUMD86HZrrVN+1bCvn1ppjZ/fOxw==`;
- `dsh -V` печатает `0.1.5-rc.2` и завершается с rc 0;
- размер установленного дерева — 306 МБ;
- у самого `@deepseek-ai/dsh` install script отсутствует. Install scripts объявляют
  транзитивные `@deepseek-ai/dsh-subprocess-local`, `@google/genai`, `koffi`, `node-pty`
  и `protobufjs`;
- присутствуют нативные артефакты `@deepseek-ai/node-addon-system-linux-x64`, Koffi,
  `node-pty`, Sharp и `node-addon-require-builtin` (`.node`/`.wasm`).

Первый запрос npm оборвался `ECONNRESET`; повтор с cache внутри рабочей площадки прошёл.
Сетевые настройки не менялись.

## Профиль и overlay

`dsh` с встроенным ACP-профилем и `--dump-config` в пустом `DSH_HOME` завершился с rc 0
примерно за 0,05 с и автоматически создал каталог профиля. Сам DSH при текущем umask создаёт часть
профиля как `0775`/`0664`. Product-код заранее создаёт приватные каталоги: runtime home,
`chat/<hash>`, `DSH_HOME` и каталог хода — `0700`, overlay/hooks — `0600`. Рекурсивный chmod
внутри `DSH_HOME` после bootstrap не делается: снаружи дерево закрывают родительские `0700`,
а секрет живёт только в env процесса, не в файлах профиля. Каталог хода
(`turns/<uuid>`) и launch-каталог metadata-probe удаляются после завершения процесса.

Исходный overlay успешно прошёл `--dump-config` и ACP-start. Дамп подтверждает:

- `sandbox-policy.mode` и абсолютный `workspaceRoot` заменяются; и в чате, и в Factory
  `workspaceRoot` равен realpath cwd. Для вызовов агента DSH берёт ту же границу из cwd
  сессии; общий каталог-предок из `extraDirs` её не расширяет
  ([грабли](../grigdesk/chat/deepseek-write-boundary.md));
- `approval.policy` заменяется;
- `permission.defaultPreset` задаётся явно. Помимо upstream-наборов объявлены
  `factory-state-only = read-only + never` и
  `factory-workspace-write = workspace-write + never`: pinned DSH иначе завершает
  загрузку профиля ошибкой «composed defaults match no preset». Это отдельные точные
  комбинации, а не переход к `danger-full-access`;
- `agent-instructions.maxBytes = 262144`;
- subagent/workflow/jobs/web-строки получают `disabled: true`;
- `hooks-claude-code` разрешается из установки без `dsh plugin add`.

## ACP: подтверждённые формы

`initialize` возвращает protocol version 1, agent `deepseek-harness-acp/0.0.1`, пустой
`authMethods`, MCP HTTP capability и session capabilities `close/list/resume`.
Metadata-only handshake успешен без ключа, с синтетическим неверным ключом и с тем же
ключом при недоступном proxy: до первого `session/prompt` эти состояния неразличимы.
Карточка может честно показывать наличие `DEEPSEEK_API_KEY`, но не его принятие сетью.

Наблюдаемые config options:

| Категория | currentValue | options |
|---|---|---|
| `model` | `["deepseek-official","deepseek-v4-flash"]` | `deepseek-flash`, `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp` в opaque JSON value |
| `reasoning_effort` | `high` | `off`, `low`, `high`, `max` |

Значения model хранятся как непрозрачные строки из `options[].value`. Невалидные model
и effort возвращают JSON-RPC `-32602` с текстами `unknown model option` и
`unknown reasoning effort …` соответственно.

## Инструменты

Подтверждённые live-формы:

| `tool_call.title` | Наблюдаемый `rawInput` | Примечание |
|---|---|---|
| `read` | `{ file_path }` | чтение внутри и вне cwd |
| `write` | `{ file_path, content, sandbox_permissions?, justification? }` | запись внутри cwd заранее разрешена; расширение границы требует permission |
| `bash` | `{ command, description, sandbox_permissions?, justification? }` | shell использует ту же файловую границу |
| `glob` | `{ pattern }` | поиск без permission |
| `grep` | `{ pattern }` | поиск без permission |
| `mcp__grigdesk-echo__echo` | `{ text }` | точная форма имени stdio MCP |

Все наблюдённые `tool_call.kind` равны `other`. `tool_call_update` использует тот же
`toolCallId`, статус `completed`/`failed` и content-массив.

Диффов в ACP нет: мост pinned `dsh-acp` собирает `tool_call_update` только из текстовых
блоков результата, и слов `diff`/`oldText`/`newText` в нём нет вовсе. DSH считает хунки
сам (`computeHunkDiffs`) и кладёт их в `tool/result.meta` для собственной карточки, но
через ACP они не выходят, и в `tool_call_update` приходит лишь подтверждение вида
`Created file` / `The file … has been updated successfully.` Поэтому лента GrigDesk строит
правку из `rawInput`: `edit` — структурный diff `old_string → new_string` (включая удаление
с пустым `new_string`), `write` — превью содержимого (у перезаписи «до» неизвестно, и
сплошное добавление соврало бы в стате `+N −0`). Обе формы обрезаны `STEP_DIFF_LIMIT`,
чтобы один шаг не раздувал сохраняемую историю чата.

Размышление модели приходит потоком `agent_thought_chunk` с текстом (`raw/c-*.ndjson`).
Лента копит куски и отдаёт одним шагом `think` перед следующим действием или сообщением,
хвост — по `flush()` при завершении хода, как у Kimi; первая редакция прятала текст за
заглушкой «DeepSeek размышляет…», и человек не видел, о чём думает агент.

Модель получила схемы `bash`, `create_goal`, `edit`, `exit_plan_mode`, `get_goal`, `glob`,
`grep`, `read`, `read_image`, `skill`, `todo_write`, `update_goal`, `write`. Инструменты
subagent/workflow/web/jobs отсутствуют. `bash` всё ещё описывает запуск в фоне, но
отдельных `job_output`/`job_kill` в схеме нет. Live-вызов `edit` снят в production-чате
20.09.2026: в `read-only` он вернул `[sandbox: file access denied under read-only mode]`
и предложение повторить с `sandbox_permissions`; файл не появился.

## Песочница и реальные границы

На проверенной Linux-машине штатный provider выбрал `bwrap` и сообщил
`enforcement: full`. Это подтверждено вызовом того же `LocalSandboxProvider`, а также
характерным поведением приватного `/tmp`. Если backend недоступен, upstream обещает
`SANDBOX_UNAVAILABLE` и fail-closed; другие платформы и Landlock здесь не проверялись.

`workspace-write`:

- относительный и абсолютный путь внутри cwd записываются file tools без permission;
- `../`, абсолютный путь наружу и путь через symlink наружу отклоняются file tools;
- shell пишет внутри cwd, но получает read-only filesystem для parent/symlink escape;
- `/tmp` внутри `bwrap` эфемерен: команда успешно пишет туда, но host-файл не появляется;
- чтение sibling-файла вне cwd разрешено и file tool, и shell.

`read-only`:

- file tools и shell не изменили cwd, parent, абсолютный внешний путь, symlink target или
  host `/tmp`;
- чтение sibling-файла вне cwd разрешено;
- после отказа модель может повторить вызов с `sandbox_permissions`. DSH тогда предлагает
  расширение до `workspace-write` или `danger-full-access`. Поэтому GrigDesk обязан
  автоматически отклонять **все** такие запросы в режиме чата `read-only`; показывать
  пользователю allow нельзя. Factory `state-only` использует `approval: never`.

Служебные записи разделены с agent writes. Сам процесс DSH пишет в приватный `DSH_HOME`
(профиль, zstd-журнал и projection cache) вне инструментальной песочницы. MCP-процесс тоже
не находится в sandbox агента и может писать только в явно выданный ему каталог/env.
Hook-команды, напротив, исполняются под policy сессии: попытка hook записать cache/log вне
cwd была запрещена. Product-hook не должен рассчитывать на writable `STATE_DIR`; `/tmp`
в `workspace-write` эфемерен, а в `read-only` недоступен для записи.

## Разрешения

Исходное расхождение сохранено в `raw/c-write-allow.ndjson` и
`raw/c-write-reject.ndjson`: при `workspace-write + approval: ask` обычный `write` внутри
cwd не создаёт `session/request_permission`, поэтому заранее подготовленный reject не мог
остановить файл. Это поведение штатного DSH без дополнительного host gate. Чат DeepSeek
теперь ставит обязательную проверку перед инструментом; обычный default write спрашивает
человека. [Текущий контракт](../grigdesk/chat/deepseek-tool-permissions.md).

Настоящий permission request получен после явного повторного вызова `write` за cwd с
`sandbox_permissions: danger-full-access` и `justification`. Reverse request содержит
только `sessionId`, `toolCall.toolCallId` и варианты `allow_once`/`reject_once`; имя и
input восстанавливаются из предшествующего `tool_call`.

- `allow-once` дал ровно один контролируемый side effect во внешнем synthetic sibling;
- `reject-once` вернул модели отказ, и целевой файл не появился;
- без явного `sandbox_permissions` нарушение границы только возвращает sandbox error.

Для `default` и `auto` запрос на
`danger-full-access` тоже требует явного человека и не может быть автоматически разрешён.
Для `read-only` он всегда отклоняется. Неизвестный reverse method и неожиданный Factory
permission request также отклоняются fail-closed.

## Режимы чата и Factory

- `default` — «Спрашивать»: чтение свободно, правки и shell требуют разового разрешения.
- `auto` — обычные файлы в cwd правит самостоятельно; все shell-команды, чувствительные
  файлы и внешние инструменты подтверждает человек. Модельного классификатора команд нет.
- `read-only` — «Только чтение»: исходники, shell и расширение sandbox запрещены,
  проектные MCP не запускаются. Внутренние todo/goal и вопросы сохраняют собственный UI.
- Factory `workspace-write` разрешает изменения проекта; `state-only` использует
  подтверждённый `read-only` + `approval: never`; `transactional-write` не поддерживается.
  Любой неожиданный Factory permission request получает `reject-once`.

При live-провокации эскалации в Factory pinned DSH увидел `approval: never`, не сделал
повтор с `sandbox_permissions` и потому не отправил reverse request вообще; внешний файл
не появился. Это provider-side fail-closed, но не доказательство вызова обработчика.
Unsolicited Factory reverse request отдельно проходит исполнимый protocol-тест и получает
`reject-once`; настоящий DSH allow/reject path доказан chat smoke.

Factory wrapper не добавляет hooks подтверждения каждой записи. При внешнем timeout весь
runner session может получить TERM одновременно, поэтому ACP `session/cancel` не является
единственной гарантией quiescence: launcher проверяет и гасит все process groups с точной
session identity. Прямой chat/server abort сначала посылает `session/cancel`. В обоих
случаях тест с упрямым tool-grandchild подтверждает отсутствие сироты; смерть прямого ACP
процесса завершает pending-запрос, даже если потомок удержал унаследованный stdout.

## Хуки

`UserPromptSubmit` получил payload с `hook_event_name`, `prompt`, `cwd` и session fields;
`additionalContext` дошёл до модели, которая ответила `CANARY-HOOK-7f3a`.
`PreToolUse` получил точные `tool_name` и `tool_input` для file tools и `bash`. Решение
`deny` вернуло модели заданную причину, а запрещённый shell-файл не появился.

Несуществующая hook-команда и запрещённая sandbox-ом служебная запись подтвердили
fail-open: hook result стал `pass`, ход и обычный `write` продолжились. Hooks не
используются для подтверждения каждой записи; механическая граница остаётся за DSH.

## MCP

Fake stdio-сервер появился как `mcp__grigdesk-echo__echo`, получил только явно заданные
canary env и args и вернул вызов. В `read-only` он записал `mcp-env.json` вне cwd, то есть
MCP действительно живёт вне песочницы агента. Это закрывает Factory-гейт: status MCP
может писать через собственный ограниченный IPC, не открывая агенту второй writable root.

Production `grigdesk-work` в P10 выявил точность ACP V1 wire-контракта: stdio declaration
обязана содержать и `args`, и `env`, даже когда второй массив пуст. Без явного `env: []`
SDK мягко убирал сервер из доступных tools. Stdio handler также не отвечает на JSON-RPC
notification `notifications/initialized`. Оба свойства закреплены process-тестом, а
runtime отклоняет неполную MCP declaration до spawn.

## Инструкции

В первом ходе без инструментов модель видела `ROOT-A` и `ROOT-C`, но не `SUB` и не
содержимое `IMPORT`: штатный plugin показывает строку `@docs/rule.md`, но не раскрывает
её. После `cat sub/AGENTS.md` следующий ход видел `SUB`. Это подтверждает необходимость
GrigDesk-hook для `@`-импортов и upstream-поведение вложенных правил.

Из-за sandbox hook не может хранить hash в launch/state-каталоге. Реализация импорта
должна быть stateless и не писать в проект: контекст вычисляется и добавляется на каждый
`UserPromptSubmit`. Это дороже прежней идеи dedup-cache, зато одинаково работает в
`workspace-write` и `read-only` и не ослабляет файловую границу.

## Сессии и resume

История хранится как `session.v3.jsonl.zstd`; рядом есть `session.lock`, а projection cache
— JSON в `storages/session_projcache`. После приватного pre-create журнал и cache созданы
с mode `0600`; `session.lock` и файлы профиля остаются `0664`/`0775` под родителем `0700`.

Новый DSH-процесс успешно сделал `session/resume` после `session/close` с тем же cwd и
воспроизвёл фразу первого процесса. Resume с другим cwd вернул JSON-RPC `-32602`:
`Invalid params: session cwd does not match: …`. Product обязан сравнивать cwd по realpath
до spawn и хранить session id только server-side.

## Cancel и завершение

`session/cancel` через две секунды во время `sleep 60` дал `stopReason: cancelled`.
После `session/close` и закрытия stdin DSH завершился с rc 0; отдельная host-проверка не
нашла marker-процесс. Startup-процессы metadata и model-сценариев также завершались сами.

## Ошибки и сигнатуры

- неверный ключ на первом prompt: JSON-RPC `-32603`,
  `Internal error: turn failed: Authentication Fails, Your api key: ****-key is invalid`;
- неверные config options: JSON-RPC `-32602`;
- sandbox file denial: `[sandbox: file access denied under <mode> mode]`;
- shell escape под `bwrap`: локализованный OS-текст read-only filesystem;
- отклонённая эскалация: `the user rejected escalating this operation to …`;
- обрыв сети до API посреди хода (production, 21.09.2026, ход в 13 минут и 338 событий):
  JSON-RPC `-32603`, `Internal error: turn failed: DeepSeek API request to
  https://api.deepseek.com failed`; в журнале DSH `turn/end` с `code: TRANSPORT`. Сессия
  при этом цела — следующий prompt сделал `session/resume` и завершился штатно. Ретрая
  на стороне DSH не наблюдалось.

Любая ошибка `session/prompt` вида `turn failed: …`, кроме `Authentication Fails`, отдаётся
чату как delivery failure (лента шагов, id сессии, метка `delivery_failure` и кнопка
«Продолжить ход»), а не как исключение: работа до обрыва видна, а продолжение — обычное
сообщение в ту же сессию. Отказ ключа остаётся ошибкой — продолжать там нечего.

429 и 413 намеренно не провоцировались и остаются сигнатурами по документации/общему
классификатору, а не live-фактами.

## Usage и цена процесса

ACP присылает `usage_update { used, size }`; `size = 1000000`, `used` — заполненность
контекста, не billing. В zstd-журнале `assistant/message.usage` содержит
`inputTokens`, `outputTokens`, `totalTokens`, `cacheReadTokens`, `reasoningTokens`, но эти
поля не являются ACP-контрактом и V1 их не читает. Billing usage остаётся `unavailable`,
не ноль.

В коротких прогонах spawn → initialize занял примерно 0,64–0,77 с, session ready —
0,68–0,86 с, RSS после initialize — 152–158 МБ. Полный простой ход занял около 3,6 с.

## Счёт и темп расхода

`GET https://api.deepseek.com/user/balance` с `Authorization: Bearer` отвечает за ~1,5 с:
`{ is_available, balance_infos: [{ currency, total_balance, granted_balance,
topped_up_balance }] }`, суммы — строки с двумя знаками, валют может быть несколько
(наблюдалась `USD`). Отдельного API расхода у вендора нет, поэтому темп считается в
`server/src/lib/deepseek/balance.ts` по снимкам баланса на каждом usage-тике: убыль между
соседними снимками за сутки, пополнения не считаются. Журнал `balance-log.json` (0600) —
в runtime home, неделя хранения. `status.deepseek.com` не в формате Statuspage: при сбое
остаётся ссылкой.

## `.env` каталога запуска

При запуске DSH из служебного каталога project `.env` не попал в shell (`ABSENT`). При
запуске непосредственно из project cwd тот же shell увидел `CANARY_ENV=1`. Поэтому
product всегда запускает процесс из приватного launch-каталога и передаёт project cwd
только в `session/new`/`session/resume`.

## P10: production acceptance

Чистая установка pinned runtime, disposable chat smoke, metadata-only
`factory-check --host-preflight` и Factory smoke завершились с rc 0. Production chat
подтвердил импорт инструкций, resume между процессами, scoped `grigdesk-work`, реальные
`allow-once`/`reject-once`, все файловые границы и остановку команды без потомка.
Production Factory подтвердил `stage_result`, неизменный source в `state-only`, правку
проекта в `workspace-write`, отказ `transactional-write` до запуска и billing usage
`unavailable`. Скан chat/Factory artifacts не нашёл raw `DEEPSEEK_API_KEY`.

Установка в штатный runtime home на рабочей машине (20.09.2026) выявила и закрыла два
дефекта, которые disposable-smoke не ловил: повторный metadata-probe падал на уже
существующем синтетическом `.git` (`EEXIST`), и регистр молча оставлял seed-модель
вместо четырёх; каталоги ходов `turns/<uuid>` не удалялись. После правки живой probe отдал
четыре модели за ~2,8 с, а production-чат через `/api/chat` на работающем сервере
подтвердил ответ модели, resume той же сессии и отказ `edit` в `read-only`.

Из агентского чата намеренно не выполнены ручной рестарт сервера и Service Worker.
Поэтому ещё не закрыты: визуальная карточка «Настройки → Исполнители», resume после
рестарта/F5, actual provider/model в UI-карточке и операторский breaker-chain/manual-switch
drill. Боевые профили не включались.

## Принятые риски V1 и остаток проверки

- hooks bridge fail-open; механическая защита — только sandbox DSH;
- writable root одна — cwd сессии и в чате, и в Factory: доверенный каталог-предок из
  overlay DSH для вызовов агента не использует; Factory status идёт отдельным MCP;
- сеть и запуск процессов sandbox не ограничивает;
- context `@`-импортов stateless добавляется каждый prompt;
- per-turn процесс добавляет измеренную startup/RSS-цену;
- платформы кроме текущего Linux `bwrap/full`, а также 429/413 не проверены live.

Обязательные сценарии P0 a–o выполнены; k/o покрыты измерениями и журналом. P1–P9
реализованы и проходят fake/contract/integration gates. Автоматизированная часть P10
повторила критичные свойства через production adapters на disposable workspace и не была
заменена fake ACP. Любое будущее расхождение с pinned runtime снова останавливает
соответствующий режим, а не приводит к автоматическому ослаблению sandbox.
