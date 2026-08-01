# План интеграции Kimi в Cockpit

Статус: **черновик после архитектурной критики; реализация не начата**

Составлен: **2026-08-01**

Рекомендуемый первый релиз: **Kimi Code CLI через Agent Client Protocol (ACP), только для страницы «Чаты»**.

> **Важно:** критика от 2026-08-01 подтвердила выбор ACP, но нашла блокирующие пробелы ниже.
> До их переноса в соответствующие этапы этот документ нельзя использовать как пошаговое
> production-задание. Формулировка «только `/chats`» также требует продуктового уточнения:
> `ChatSession` и общий backend используются несколькими поверхностями Cockpit.

## 0. Результат архитектурной критики

Перед adapter-кодом план нужно сократить до исполнимого manual-only vertical slice и явно закрыть:

1. **Миграцию идентичности модели и сессии.** Вместо глобально неоднозначных `model` и
   `sessionId` нужен `modelRef: { provider, model }` и binding вида
   `{ provider, sessionId, cwd, model, authProfile?, securityProfile? }`. В план должны войти
   миграция истории/дефолтов, provider-scoped lookup, смена task/cwd и multi-window merge tests.
2. **Durable ранний session ID.** Callback `onSession()` сам ничего не сохраняет. Chat core должен
   write-through патчить `ChatHistoryStore` под lock, обновлять `activeRuns`, публиковать SSE и
   защищать новый binding от stale PUT другого окна.
3. **Конкретную модель угроз.** Процессу Kimi нужны credentials, а локальный shell живёт в том же
   filesystem namespace. Обычный bind-mount не может одновременно открыть secret родителю и
   доказанно скрыть его от shell-потомка. Нужен явный выбор: отдельный Unix user/container и
   минимальный аккаунт; brokered FS с запретом Bash; либо честный experimental/manual-only риск.
4. **ACP filesystem-развилку.** Отсутствие client FS capabilities не создаёт изоляцию — Kimi
   использует локальную файловую реализацию; reverse FS может ограничить read/write, но shell
   остаётся локальным. Rooted FS broker и запрет Bash/фоновых задач должны предшествовать обещанию
   containment.
5. **Вложения без недокументированных полей.** Kimi `0.31.1` не объявляет
   `sessionCapabilities.additionalDirectories`; по ACP клиент не должен отправлять это поле без
   capability. Вложения для sandbox-профиля нужно staging/bind-mount-ить read-only внутрь видимого
   корня и переписывать путь в prompt. См. [матрицу Kimi ACP](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp)
   и [ACP additional directories](https://agentclientprotocol.com/rfds/additional-directories).
6. **Завершение дерева процессов.** Stop обязан останавливать process group/cgroup, включая shell,
   фоновые задачи и MCP-потомков. Убийство одного PID `kimi acp` недостаточно.
7. **Retry policy.** После передачи prompt автоматический retry запрещён: оборвавшийся транспорт не
   доказывает, что действие не выполнилось. Допустим только подтверждённый pre-prompt retry.
8. **Автозагружаемое окружение Kimi.** В spike входят user/project MCP, skills, plugins, hooks,
   инструкции и двойное хранение prompts/tool trace самим Kimi. Нужно выбрать обычный профиль или
   отдельный sanitised `KIMI_CODE_HOME`.
9. **Run-scoped interaction broker.** Идентичность включает `runId`, `sessionId`, `toolCallId` и
   `AbortSignal`; одного `chatKey` недостаточно. Broker передаётся executor-у зависимостью, не
   импортируется singleton-ом.
10. **Scope UI.** Либо первый релиз относится ко всему chat subsystem, либо Kimi фильтруется и
    корректно деградирует во всех общих `ChatSession`-поверхностях. Клиентский `context.path` не
    является серверной security-границей.

Отдельный встроенный просмотрщик MD/TXT уже спроектирован как core-модуль и описан в
[документации](documents.md). Он решает доступ к артефактам с планшета, но не является частью или
зависимостью Kimi-интеграции.

## Короткий ответ

Да, добавить Kimi можно. Архитектура Cockpit уже рассчитана на подключаемые CLI-исполнители:
один новый executor автоматически попадает в реестр провайдеров, выбор модели и настройки.

Для первого релиза следует подключать не «голую» Moonshot API, а официальный **Kimi Code CLI**
через `kimi acp`. Это сохраняет привычную для Cockpit модель локального coding-agent: рабочий
каталог, инструменты, сессии, поток шагов, отмена и интерактивные разрешения. Прямой HTTP API
потребовал бы отдельно реализовать хранение всей истории, цикл вызова инструментов, доступ к
файлам и permission UX.

Интеграция в Factory/Engine — отдельная работа после стабилизации Kimi в чатах. Наличие
chat-executor само по себе не делает Kimi исполнителем конвейера.

## 1. Цель и границы первого релиза

### Пользовательские сценарии

- Kimi появляется третьим исполнителем в «Настройки → Исполнители».
- После установки и `kimi login` пользователь видит доступные модели Kimi в новом или
  существующем чате.
- Новый чат умеет продолжать Kimi-сессию после перезагрузки страницы и перезапуска Cockpit.
- В ответе живьём видны текст, вызовы инструментов, результаты и опубликованные агентом заметки.
- Кнопка «Стоп» отменяет текущий ACP-запрос и гарантированно завершает дочерний процесс.
- Опасное действие Kimi вызывает существующую всплывашку разрешения Cockpit; отказ действительно
  запрещает действие.
- При смене модели или провайдера создаётся новая сессия, и контекст разных провайдеров не
  смешивается.

### Входит в MVP

- только страница `/chats` и вызовы из её общего chat backend;
- авторизация, которой владеет Kimi CLI: OAuth/device login либо настроенный самим CLI API key;
- текстовые сообщения, локальные файлы и уже существующий механизм вложений-путей;
- ACP-сессии, streaming, cancel, разрешения, модели, режимы и effort — только в объёме,
  объявленном установленной версией CLI;
- безопасное отображение состояния «не установлен», «нужен вход», «версия не проверена»;
- полностью офлайн-регрессия на fake ACP-процессе.

### Не входит в MVP

- Kimi как runner Factory/Engine, triage или исполнитель других фоновых подсистем;
- самостоятельное хранение Kimi API key в `prefs.json` или `.env` из UI;
- встроенный web search, видео, Files API и нативные image content blocks;
- автоматическое пополнение баланса, покупка квоты или скрейпинг закрытых usage endpoints;
- общий демон Kimi на все чаты;
- автоматическая установка или бесконтрольное обновление CLI;
- режимы `auto`/`yolo`, пока не пройден файловый security-гейт.

## 2. Что уже готово в Cockpit

| Область | Что есть | Что требуется для Kimi |
|---|---|---|
| Исполнители | `server/src/lib/executors/index.js` сканирует каталог: один файл — один ИИ | Добавить `kimi.js` и вспомогательные ACP/stream-модули |
| Провайдеры | Backend и Settings в основном строятся из контракта executor-а | Добавить probe/auth/capabilities Kimi; не делать специальных веток в UI без необходимости |
| Модели | Есть общий `models-registry.js`, seed и обновление каталогов | Отделить стартовый каталог от runtime-возможностей конкретного аккаунта и версии CLI |
| Чат | Есть очередь на чат, `sessionId`, SSE шагов, stop, compact и вложения | Адаптировать ACP lifecycle и не смешивать Kimi-сессии с Claude/Codex |
| Разрешения | Есть очередь, SSE и UI, но вход в неё завязан на Claude permission MCP | Вынести provider-neutral interaction broker; ACP вызывает его прямо |
| Окружение | Сейчас общий chat route дополняет env данными Claude | Формировать env конкретного провайдера и исключить утечку чужих ключей |
| Режим страницы | `/agents` задаёт Claude-специфичный `acceptEdits` | Передавать семантическое намерение и выбирать безопасный режим самого executor-а |
| Factory | Реестр runner-ов расширяемый, но контракт отличается от chat executor | Рассматривать отдельным этапом после MVP |

Перед реализацией нужно убрать ещё одну опасную неоднозначность: запрос чата должен разрешать
пару `(provider, model)`. Неизвестная либо устаревшая модель должна давать явную ошибку, а не
молча отправляться исполнителю по умолчанию.

На хосте аудита 2026-08-01 бинарь `kimi` не установлен, поэтому живой handshake не выполнялся и
вынесен в обязательный этап 0. Установленный Node.js `22.22.1` подходит текущей npm-сборке Kimi,
но заявленный Cockpit минимум `>=22` не гарантирует требуемые Kimi `>=22.19` на другой машине.

## 3. Выбор транспорта

| Вариант | Плюсы | Ограничения | Решение |
|---|---|---|---|
| `kimi acp` | Нативные сессии, streaming, cancel, permission requests, model/mode config, MCP | ACP и Kimi CLI пока быстро меняются; нужен JSON-RPC client и security-аудит локальных инструментов | **Выбрать для MVP** |
| `kimi -p --output-format stream-json` | Проще запустить как обычный CLI | Print mode автоматически подтверждает действия; несовместим с режимами `--plan`/`--auto`/`--yolo`, поэтому не воспроизводит UX разрешений Cockpit | Не использовать |
| Moonshot/Kimi Chat Completions API | Прямой HTTP, динамический `/models`, собственный контроль запроса | Stateless API: нужно заново строить историю, agent loop, tools, permissions, файлы, reasoning state и retry policy | Возможный отдельный answer-only provider позже |
| OpenAI-/Anthropic-compatible endpoint | Удобен для настройки сторонних клиентов | Это совместимый inference endpoint, а не интеграция локального coding-agent | Не считать интеграцией Cockpit |

Важно не перепутать продукты: целевой CLI — новый репозиторий
[`MoonshotAI/kimi-code`](https://github.com/MoonshotAI/kimi-code), а не старый `kimi-cli`.

## 4. Целевая архитектура

```text
браузер
  └─ POST /api/chat/run + SSE
       └─ provider/model resolver
            └─ Kimi executor
                 ├─ запускает отдельный `kimi acp` на активный ход
                 ├─ ACP client ↔ JSON-RPC по stdin/stdout
                 ├─ session/update ──> нейтральные шаги Cockpit ──> SSE
                 ├─ session/request_permission ──> interaction broker ──> браузер
                 └─ session/cancel + завершение процесса при Stop/Abort
```

Для MVP один ACP-процесс живёт только во время одного активного хода:

1. Cockpit запускает `kimi acp` без shell и подключает официальный TypeScript ACP SDK.
2. Выполняет `initialize`, проверяет версию протокола и состояние авторизации. В первом MVP не
   объявляет ACP filesystem/terminal capabilities, пока Cockpit не реализовал их полностью.
3. Без `sessionId` создаёт новую сессию и сразу сообщает ID chat core — ещё до prompt. С
   `sessionId` сначала через `session/list({ cwd })` проверяет принадлежность сессии текущему
   canonical workspace, затем использует `session/resume`. Обычный ход не использует
   `session/load`: replay старых updates дал бы дубликаты в UI.
4. Применяет только объявленные сессией model, effort и mode config options.
5. Отправляет prompt и нормализует `session/update` в шаги Cockpit.
6. Обслуживает reverse requests разрешений, вопросов и поддержанных файловых операций.
7. По завершении сохраняет итоговое состояние, закрывает stdin/ACP connection и дочерний процесс.
   В текущем протоколе Kimi нет `session/close`, поэтому после grace period процесс завершается
   явно.
8. По Abort сначала отправляет `session/cancel`, затем после короткого grace period завершает
   процесс; зависший процесс уничтожается принудительно.

Такой lifecycle немного дороже постоянного демона, но изолирует параллельные чаты, упрощает
рестарт Cockpit и не оставляет безнадзорных процессов. Пул или долгоживущий процесс допустимы
только позже, после измерения startup latency и проверки изоляции сессий.

### Отображение на контракт executor-а

| Поле/метод | Поведение Kimi |
|---|---|
| `id`, `name`, `vendor`, `order` | `kimi`, `Kimi`, `Moonshot AI`, порядок после текущих провайдеров |
| `bin(config)` | `config.kimiBin`, дефолт `kimi` |
| `probe(config)` | `kimi --version`, без сетевого model call |
| `auth(config, deps)` | Проверка ACP auth state без чтения/копирования credential-файла |
| `seedModels()` | Минимальный документированный bootstrap-каталог Kimi Code, помеченный датой |
| `catalog()` | Кэш runtime `configOptions`; не создавать служебную сессию на каждом опросе |
| `modes()` | Только режимы, объявленные текущим ACP; на старте — безопасные `default`/`plan` |
| `efforts()` | Только уровни из model/effort config options текущей сессии |
| `usage()` | `unsupported`, пока нет документированного machine-readable контракта |
| `compaction` | `native` только после контрактного теста `/compact`, иначе `summary` |
| `run(opts)` | ACP lifecycle, stream normalization, permission bridge, cancel и typed errors |

## 5. Этап 0 — контрактный spike и go/no-go гейты

На дату аудита актуальная ветка Kimi Code имеет версию `0.31.1`, но CLI находится в серии `0.x`.
До написания production-адаптера нужно зафиксировать реальный wire contract этой версии и
проверить его повторяемость на чистом профиле.

### Проверки ACP

- [ ] Зафиксировать проверенную версию Kimi Code и версию `@agentclientprotocol/sdk`.
- [ ] Снять обезличенные JSON-RPC fixtures для `initialize`, auth-required/authenticated,
  `session/new`, `session/load`/`resume`, `session/prompt` и завершения хода.
- [ ] Проверить получение и сохранение session ID до первого prompt, выход ACP-процесса и
  продолжение новым процессом.
- [ ] Проверить `session/list({ cwd })` и отказ от resume, если ID принадлежит другому workspace.
- [ ] Для обычного продолжения использовать `session/resume`; отдельно доказать, что `load` replay
  не попадает в живую ленту и не дублирует историю.
- [ ] Проверить `session/cancel`, выход дочернего процесса и состояние прерванной сессии.
- [ ] Зафиксировать формы text/thought/tool/plan updates и порядок partial tool updates.
- [ ] Проверить `session/request_permission`: allow once, reject, завершение процесса во время
  ожидания и фактический запрет инструмента после reject.
- [ ] Проверить вопросы. Текущий адаптер Kimi сводит несколько вопросов к первому и multi-select
  к single-select — UI и тесты не должны обещать больше.
- [ ] Снять runtime model/mode/effort `configOptions` для OAuth и API-key конфигураций.
- [ ] Проверить смену модели до prompt и продолжение сессии после смены.
- [ ] Проверить `/compact` через ACP; не объявлять native compact до успешного теста.
- [ ] Проверить, публикует ли ACP token/context/cost usage. Отсутствие данных считать штатным
  `unavailable`, а не нулевым расходом или выдуманной оценкой.
- [ ] Проверить ошибки: CLI не установлен, нет входа, протокол не совпал, процесс умер, битый JSON,
  rate limit, provider overload и потеря сети.

### Security-гейт файлов и shell

В текущем Kimi Code ACP параметр дополнительных директорий не даёт Cockpit доказанной
песочницы, а shell выполняется самим локальным процессом. Даже ACP filesystem capabilities не
ограничивают shell автоматически.

- [ ] Проверить чтение/запись вне `cwd`, каждого `extraDir` и каталога вложений.
- [ ] Проверить выход через symlink, `..`, bind mount и подмену пути между проверкой и открытием.
- [ ] Выбрать и прототипировать OS-level containment для Linux-процесса либо доказать эквивалентное
  ограничение целевой версии CLI.
- [ ] Разрешать только realpath-корни, вычисленные сервером; неизвестный/исчезнувший корень — отказ.
- [ ] Проверить, что reject блокирует shell/write, а read-only операции не обходят установленную
  границу.
- [ ] До прохождения гейта не публиковать `auto`/`yolo`; при отсутствии containment держать
  провайдер экспериментальным и выключенным по умолчанию.

### Результат этапа

Spike завершается коротким отчётом с:

- матрицей «версия CLI ↔ версия ACP ↔ поддержанные возможности»;
- fixtures без prompts, исходников, токенов и домашних путей;
- выбранной схемой containment;
- списком подтверждённых отклонений от документации;
- решением `GO`, `GO manual-only/experimental` либо `NO-GO`.

Без успешных resume, cancel, reject и filesystem containment интеграцию нельзя считать
готовой к обычному включению.

## 6. Этапы реализации

### Этап 1 — сделать chat core нейтральным к провайдеру

- [ ] Добавить `COCKPIT_KIMI_BIN` и опциональный `COCKPIT_KIMI_ENABLED`; документировать в
  `.env.example`.
- [ ] Передавать в chat API явные `provider` и `model`; валидировать их пару по registry.
- [ ] Убрать молчаливый fallback неизвестной модели к Claude; вернуть `unknown_provider` или
  `unknown_model` до запуска процесса.
- [ ] Ввести provider-specific env hook. Kimi не должен получать добавленные Cockpit ключи
  Anthropic/OpenAI; Claude и Codex продолжают получать только свои данные.
- [ ] Выделить interaction broker из HTTP-роута разрешений:
  `requestInteraction({ chatKey, provider, kind, tool, input, options })`.
- [ ] Оставить Claude permission MCP тонким адаптером к тому же broker-у.
- [ ] Подключить к broker-у отмену по abort, смерти процесса, завершению хода и таймауту.
- [ ] Заменить Claude-специфичный page default `acceptEdits` на provider-neutral intent.
  Неизвестный режим всегда падает в самый безопасный режим executor-а, но никогда не повышается
  до `auto`/`yolo`.
- [ ] Сохранить текущую FIFO-очередь: два процесса не должны одновременно продолжать одну Kimi-сессию.

### Этап 2 — реализовать Kimi ACP executor

- [ ] Добавить и зафиксировать точную проверенную версию `@agentclientprotocol/sdk` в server lockfile.
  Начальная кандидатура для Kimi Code `0.31.1` — SDK `0.23.0`, но окончательно закрепить её только
  после fixtures этапа 0.
- [ ] Реализовать запуск через `spawn(kimiBin, ['acp'])` без shell; stdout принадлежит только
  JSON-RPC, stderr читается отдельно и проходит redaction/лимит размера.
- [ ] Реализовать initialize/auth/new/resume/prompt/close lifecycle из раздела 4.
- [ ] На `AbortSignal` отправлять cancel ровно один раз и гарантированно убирать child process.
- [ ] Нормализовать ACP updates в существующие шаги `start`, `think`, `text`, `tool`, `res`, `note`.
- [ ] Показывать только опубликованные провайдером summaries/updates; не логировать и не выдавать
  скрытое reasoning.
- [ ] Стабильно собирать partial text и tool calls по идентификаторам, не дублировать финальный текст.
- [ ] Преобразовать ошибки в типы Cockpit с безопасным сообщением пользователю и диагностической
  причиной в server log.
- [ ] Расширить внутренний контракт callback-ом раннего `onSession(sessionId)` либо эквивалентным
  механизмом: ID первого прерванного хода не должен теряться.
- [ ] Вернуть `{ reply, sessionId, actualModel, steps }`; usage-поля заполнять только при наличии
  подтверждённого события ACP.
- [ ] Не объявлять `updateCmd` в первом релизе: установка и обновление остаются явной операцией
  пользователя.

### Этап 3 — разрешения и вопросы

- [ ] Маппить объявленный конкретным ACP-запросом вариант одноразового разрешения на кнопку
  «Разрешить», а вариант отказа — на «Отклонить». Не хардкодить имя option ID без fixture:
  оно может меняться между версиями.
- [ ] Не превращать «Разрешить» в постоянное `allow_always` без отдельного UI и понятной области
  действия. Если постоянное разрешение понадобится, сначала ограничить его текущей Kimi-сессией.
- [ ] Передавать пользователю исходные названия вариантов, но валидировать возвращённый option ID
  по списку конкретного запроса.
- [ ] Вопросы нормализовать в тот же broker, явно учитывая текущую границу Kimi: один вопрос и
  single-select.
- [ ] При F5 сохранять уже существующее поведение Cockpit: pending interaction остаётся видимым,
  пока жив ход; после смерти child process снимается у всех окон.
- [ ] Никогда не разрешать действие из-за сетевой ошибки, таймаута или неизвестного ответа —
  все такие случаи fail closed.

### Этап 4 — модели, режимы, контекст и сессии

- [ ] Не смешивать идентификаторы Kimi Code (`k3`, `k3-256k`, `kimi-for-coding`, …) с именами
  моделей прямого Moonshot API: это разные каталоги и контракты.
- [ ] Seed-каталог использовать только до первого runtime snapshot и помечать источником/датой.
- [ ] Сохранять runtime `configOptions` по версии CLI и аккаунту после реальной `session/new`,
  не создавая мусорную сессию каждые несколько минут ради каталога.
- [ ] При изменении модели Kimi сбрасывать `sessionId`: документация рекомендует новую сессию,
  поскольку смена модели инвалидирует prompt cache.
- [ ] Effort отправлять только если он объявлен выбранной моделью; неизвестное значение — 400,
  без догадок и автоматической замены.
- [ ] Режимы первого релиза: `default` и `plan`. `auto`/`yolo` становятся видимыми только при
  успешном security capability check.
- [ ] Если ACP не отдаёт context tokens, UI показывает «данных нет». Не рисовать точное кольцо
  из длины строки и не записывать `0` как подтверждённый расход.
- [ ] Native compact включить только на версиях, где fixture подтверждает `/compact`; для остальных
  оставить существующий summary fallback с новой сессией.
- [ ] Не реализовывать account usage через парсинг `/usage` или приватных HTTP endpoints. В Settings
  показать `unsupported` и безопасную подсказку открыть официальный Kimi интерфейс/CLI.

### Этап 5 — файлы, вложения и containment

- [ ] Передавать рабочий каталог, worktree, trusted directories и каталог вложений только после
  canonicalization и проверки allowlist.
- [ ] Не считать `additionalDirectories` доказательством sandbox; отдельно ограничить весь процесс,
  включая shell.
- [ ] По умолчанию дать запись только в текущий `cwd`; доверенные рабочие корни подключать явно,
  а каталог загруженных вложений монтировать read-only.
- [ ] На первом релизе оставить вложения локальными путями из существующего безопасного upload
  каталога. ACP image content blocks вынести в отдельную задачу.
- [ ] Не прокидывать Kimi произвольные MCP servers из пользовательского ввода. Каждый сервер,
  команда и env должны происходить из доверенной конфигурации Cockpit.
- [ ] Проверить работу containment не только happy path, но и после resume, compact и cancel.

### Этап 6 — UI и эксплуатация

- [ ] Использовать общую карточку provider settings: версия, auth state, путь к бинарнику,
  capability/status и ссылка на инструкцию входа.
- [ ] Добавить Kimi-иконку необязательно для функционального MVP; fallback с буквой уже работает.
- [ ] Русифицировать labels/hints режимов, но сохранять реальные ACP IDs в запросе.
- [ ] Показывать предупреждение для неподдержанной версии CLI и отключённого security capability.
- [ ] После переключения Claude ↔ Codex ↔ Kimi либо модели внутри Kimi визуально подтверждать новый
  контекст и очищать старый session ID.
- [ ] Не выбирать Kimi моделью по умолчанию автоматически после установки.
- [ ] Учесть, что executor registry кэшируется на процесс: после первой установки/включения нужен
  контролируемый рестарт Cockpit либо явная инвалидизация реестра.

## 7. Установка, авторизация и секреты

Операторская инструкция первого релиза:

1. Установить официальный Kimi Code по
   [Getting Started](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html).
2. Проверить `kimi --version`.
3. Выполнить `kimi login` в терминале владельца Cockpit.
4. При нестандартном пути задать `COCKPIT_KIMI_BIN=/absolute/path/to/kimi`.
5. Перезапустить Cockpit и проверить карточку исполнителя.

Cockpit не должен запускать `curl | bash`, вводить OAuth-код за пользователя, читать внутренний
credential-файл или копировать токен в своё состояние. При npm-установке нужно учитывать, что
актуальный Kimi Code требует Node.js не ниже 22.19; общий минимум Cockpit `>=22` сам по себе этого
не гарантирует. Официальный standalone installer можно описать как рекомендуемый путь, но запуск
всегда остаётся явным действием оператора.

Отдельный `KIMI_CODE_HOME` упрощает mounts и очистку состояния, но не является границей секретов:
ACP-процессу нужны credentials, а запускаемый им локальный shell может оказаться в том же
filesystem namespace. В spike нужно проверить эту угрозу отдельно. До доказанного ограничения —
OAuth, отдельный минимально-привилегированный аккаунт, ручные approvals и отсутствие
`auto`/`yolo`; долгоживущий API key в окружение agent shell не передавать.

Логи не содержат:

- Bearer/API/OAuth tokens и значения credential env;
- полный prompt или содержимое файлов по умолчанию;
- домашние абсолютные пути в telemetry/fixtures;
- сырые permission inputs после завершения диагностического retention window.

## 8. План тестирования

### Offline unit/contract tests

В CI реальный Kimi и реальные model calls запрещены. Нужен fake `kimi` binary либо in-memory ACP
transport, который воспроизводит зафиксированные обезличенные fixtures.

- [ ] probe: установлен/не установлен, корректная и неподдержанная версия;
- [ ] auth: authenticated, auth required, сломанный handshake;
- [ ] new/resume: сохранение ID, продолжение, неизвестная/удалённая сессия;
- [ ] session ownership: отказ при несовпадении canonical `cwd`, отсутствие replay-дубликатов;
- [ ] streaming: partial text, thought summary, tool start/update/result, plan update, final reply;
- [ ] permission: allow once, reject, invalid option, timeout, F5, смерть child process;
- [ ] question: single choice и честная деградация неподдержанных форм;
- [ ] abort: cancel, grace timeout, принудительное завершение, отсутствие orphan process;
- [ ] error: stderr flood, malformed JSON-RPC, EOF, auth/rate/network/provider failures;
- [ ] model/mode/effort: только объявленные options, безопасный fallback режима;
- [ ] смена модели/провайдера сбрасывает session ID;
- [ ] context/usage: отсутствие данных отображается как unavailable, а не как точное число;
- [ ] env isolation: Kimi child не получает добавленные Claude/Codex credentials;
- [ ] credential boundary: tool/shell не читает Kimi credentials либо остаточный риск явно
  блокирует обычный rollout;
- [ ] filesystem: outside-root, symlink escape, исчезнувший root и write после reject;
- [ ] routing: неизвестная пара provider/model не запускает ни один executor;
- [ ] совместимость: Claude и Codex проходят прежние chat/permission/compact тесты без изменений.

Предлагаемые файлы:

- `tests/server/kimi-acp.test.js`;
- `tests/server/kimi-stream-steps.test.js`;
- `tests/server/kimi-session.test.js`;
- `tests/server/kimi-abort.test.js`;
- `tests/server/kimi-permissions.test.js`;
- `tests/server/kimi-security.test.js`;
- `tests/server/chat-provider-routing.test.js`;
- `tests/fixtures/kimi-acp/` с очищенными JSON-RPC fixtures;
- web component/store tests только для добавленного состояния Kimi и сброса сессии.

### Явный локальный smoke test

Запускается человеком, не входит в обычный suite и может расходовать квоту:

1. Войти в Kimi CLI и открыть новый Kimi-чат.
2. Получить текстовый ответ и поток шагов.
3. Прочитать файл внутри `cwd`.
4. Запросить запись, один раз разрешить и проверить результат.
5. Повторить запись и отклонить — файл не меняется.
6. Остановить долгий ход и убедиться, что процесс исчез.
7. Перезагрузить страницу, продолжить ту же сессию.
8. Перезапустить Cockpit, снова продолжить сессию.
9. Сменить модель — получить новую сессию без старого контекста.
10. Попытаться выйти за разрешённый root — получить отказ.

После реализации прогнать целевые Node/Vue тесты, затем полный suite:

```bash
bash tests/run-all.sh
```

## 9. Файлы предполагаемых изменений

| Файл | Назначение |
|---|---|
| `server/src/config.js`, `.env.example` | `kimiBin`, feature/security flags |
| `server/package.json`, `server/package-lock.json` | Зафиксированный ACP SDK |
| `server/src/lib/executors/kimi.js` | Контракт Kimi provider/executor |
| `server/src/lib/executors/_kimi-acp.js` | Процесс, JSON-RPC lifecycle, cancel и cleanup |
| `server/src/lib/executors/_kimi-steps.js` | Нормализация ACP updates в шаги Cockpit |
| `server/src/lib/executors/_kimi-capabilities.js` | Проверенная версия, runtime options и capability snapshot |
| `server/src/lib/chat/interaction-broker.js` | Общие разрешения/вопросы для Claude, Kimi и следующих провайдеров |
| `server/src/modules/chat/index.js` | Явный provider/model routing, env hook, broker, safe page mode |
| `server/src/lib/models-registry.js` | Kimi seed/runtime catalog без смешения ID |
| `web/src/views/chat/ChatSession.vue` | Состояния Kimi, безопасные режимы, сброс сессии |
| `web/src/views/SettingsView.vue` | Только если общей карточке не хватает capability warning |
| `web/src/shared/ProviderIcon.vue` | Необязательная фирменная иконка |
| `tests/server/*kimi*`, `tests/fixtures/kimi-acp/` | Offline-контракт и регрессия |
| `docs/cockpit/chat-agents.md`, `architecture.md`, `.env.example` | Документация после реализации |

Список ориентировочный: если provider-neutral broker естественнее выделить иначе, важен его
контракт и единое владение pending interactions, а не имя файла.

## 10. Rollout и rollback

1. **Experimental:** Kimi виден только при feature flag, поддерживается одна зафиксированная версия,
   `default`/`plan`, ручной smoke на тестовом проекте.
2. **Limited:** расширить проверенный диапазон версий, включить capability snapshot, несколько
   реальных чатов без чувствительного кода, наблюдать resume/cancel/permission errors.
3. **Default available:** показывать установленный Kimi всем локальным пользователям Cockpit только
   после filesystem/security gate и полного regression suite.
4. **Расширение режимов:** включать `auto`/`yolo` отдельно, когда containment проверен для них.

Rollback должен быть простым: выключить feature flag и перезапустить Cockpit. Kimi-сессии остаются
в хранилище самого CLI, но Cockpit не переводит их автоматически в другого провайдера и не удаляет.
Ошибка Kimi не должна автоматически отправлять исходный prompt Claude или Codex: это неожиданная
передача данных другому поставщику.

Минимальная наблюдаемость без утечки данных:

- версия CLI/ACP, provider и хэш/короткий ID сессии;
- latency handshake, first update и полного хода;
- число и типы шагов без их содержимого;
- причина cancel/exit и нормализованный класс ошибки;
- число pending interactions и orphan child processes;
- security capability, с которым был запущен ход.

## 11. Критерии готовности MVP

- [ ] Kimi обнаруживается и показывает корректный auth/version state без model call.
- [ ] Новый чат, resume после F5 и resume после рестарта работают на проверенной версии CLI.
- [ ] Provider/model разрешается явно; чужой executor не получает запрос при ошибке.
- [ ] Поток текста и инструментов не дублируется и восстанавливается из active run после F5.
- [ ] Allow once разрешает ровно текущий запрос, reject фактически блокирует действие.
- [ ] Stop не оставляет ACP/Kimi процесс и не оставляет зависшую permission карточку.
- [ ] Смена модели/провайдера гарантированно начинает новую сессию.
- [ ] Отсутствующие context/usage данные честно помечены unavailable.
- [ ] Kimi не получает добавленные credentials других провайдеров; секреты не попадают в логи.
- [ ] Доступ к файлам ограничен подтверждёнными корнями либо провайдер остаётся experimental и
  выключенным по умолчанию; `auto`/`yolo` недоступны до security gate.
- [ ] Все Kimi-тесты офлайн, а полный `bash tests/run-all.sh` зелёный.
- [ ] Документация установки, входа, ограничений, обновления и rollback обновлена.

## 12. После MVP

### Kimi в Factory/Engine

Это отдельный план: `engine/lib/runners/kimi.sh`, полный runner contract, capability/preflight,
11-колоночный каталог моделей, status protocol, error classifier, offline fake binary и тесты
failover. Сначала runner должен доказать локальные tools, interrupt и отчёт этапа; простого ответа
модели недостаточно.

### Прямой Kimi API

Имеет смысл только как отдельный answer-only/multimodal provider. Для него понадобятся credential
store `0600`, выбор global/China region, динамический `/models`, сохранение полной assistant-записи
вместе с Kimi reasoning fields, SSE/tool-call assembler, attachments upload/base64, rate limiting,
бюджеты и отдельное privacy/legal решение. Не следует прятать этот объём внутри ACP executor-а.

### Дополнительные возможности

- нативные image content blocks ACP;
- session-scoped «разрешать всегда» с отдельным журналом;
- usage при появлении публичного машинного контракта;
- долгоживущий ACP process manager, если измерения докажут пользу;
- поддержка новых режимов и config options исключительно через capability discovery.

## 13. Открытые вопросы перед GO

| Вопрос | Решение по умолчанию |
|---|---|
| Какая минимальная/максимальная версия Kimi поддерживается? | Только версия из spike; расширять диапазон отдельными fixtures |
| Чем ограничить local shell и чтение файлов? | OS-level containment; без него experimental/manual-only и выключено по умолчанию |
| Можно ли получить каталог без создания сессии? | Проверить в spike; иначе seed + snapshot первой реальной сессии |
| Что делать с постоянным разрешением? | Не показывать в MVP, выбирать advertised-вариант «один раз» |
| Как отображать несколько вопросов/multi-select? | Не обещать; показать честную текущую single-choice деградацию Kimi |
| Есть ли точные context/usage данные в ACP? | Использовать только подтверждённые; иначе unavailable |
| Работает ли `/compact` как ACP prompt? | Fixture-гейт, иначе summary compact |
| Нужна ли фирменная иконка? | После функционального MVP |
| Можно ли отправлять чувствительный код в Kimi? | Явно документировать vendor/region/data policy; решение принимает оператор |

## 14. Официальные источники

Состояние источников проверено 2026-08-01:

- [Kimi Code — официальный репозиторий](https://github.com/MoonshotAI/kimi-code)
- [Kimi Code: Getting Started](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html)
- [Команда `kimi acp`](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp)
- [Справочник команды `kimi`](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html)
- [Модели Kimi Code](https://www.kimi.com/code/docs/en/kimi-code/models.html)
- [Сессии и compact](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions.html)
- [Конфигурация провайдеров Kimi Code](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers.html)
- [Переменные окружения Kimi Code](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/env-vars)
- [ACP TypeScript SDK](https://agentclientprotocol.com/libraries/typescript)
- [ACP: additional directories и требования к файловой безопасности](https://agentclientprotocol.com/rfds/additional-directories)
- [Moonshot/Kimi API Overview — для отложенного HTTP-варианта](https://platform.kimi.ai/docs/api/overview)
