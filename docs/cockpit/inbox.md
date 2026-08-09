# Общий Inbox и каналы

Inbox — отдельный системный плагин и единственная очередь обращений, из которых
создаются задачи B24. Telegram и GitHub Issues — независимые каналы: они владеют
подключением провайдера, ingress, нативным архивом и allowlist, но не владеют общей
очередью, решениями или моделью разбора.

## Три независимых состояния

У каждого канала есть три оси, и UI не смешивает их:

| ось | действие | что меняется |
|---|---|---|
| системный плагин | включить/выключить в настройках | доступны ли страница, routes и network loop канала |
| provider connection | `connect`, `recheck`, `disconnect` на странице канала | credentials, ingress и verified provider identity |
| участие в Inbox | `activate`, `deactivate` на `/inbox` | допускаются ли новые сообщения в общую очередь |

Connect не активирует Inbox. Activate не подключает provider. Обычное выключение общего
плагина Inbox не стирает channel stores и не отключает provider ingress.

`deactivate` атомарно закрывает текущую activation epoch. Сообщения до первой activation
и в промежутке между epochs не становятся backlog после следующего включения. Уже
допущенные unresolved items остаются видимыми. `disconnect` сначала отзывает новый ingress
и leases, ждёт начатые account-scoped операции, закрывает открытую epoch и удаляет только
active credentials; сохранённый namespace остаётся доступен read-only.

Reconnect той же immutable provider identity возвращает тот же `accountRef`, archive,
rules, activation history и decisions, но сам Inbox повторно не активирует. Другой bot
или repository получает новый случайный `accountRef`, пустой allowlist и состояние
`never_activated`.

## HTTP и real-time

- `/inbox`: общая очередь и управление participation;
- `GET /api/inbox`, `/api/inbox/summary`, `/api/inbox/status`;
- `POST /api/inbox/channels/:channel/activate|deactivate`;
- `POST /api/inbox/items/:ref/task|dismiss|reset`;
- SSE `inbox-changed` сообщает, что снимок надо перечитать; payload не является append log;
- навигационный store дополнительно читает summary раз в минуту, потому что Telegram bundle
  может созреть после окна тишины без нового сообщения. Поле `summary.reviewCount` и чип
  на пункте Inbox показывают всю очередь «К разбору»: карточки `new|mixed`, включая ещё
  не завершившие окно тишины; при нуле чип скрыт.

`GET /api/inbox` вместе со снимком очереди отдаёт публичное состояние общего
автообработчика (`worker.readiness`). UI не заставляет человека угадывать тишину автомата:
`no_model`, `no_b24`, остановка и недоступность показаны именованным баннером. У каждого
item есть безопасная публичная проекция `autoTask: {enabled, readyAtMs}` — без quota,
policy refs и нативных ID. Пока `readyAtMs` не наступил, карточка показывает обратный
отсчёт и предупреждает, что новое сообщение продлит окно; после него честно пишет, ждёт
ли обращение авторазбора или автомат приостановлен. Ручные кнопки доступны и во время
ожидания: окно тишины ограничивает только автомат.

Неуспешная подготовка вложений публикуется в `worker.analysisRequired` только как opaque
item ref, безопасный code и время следующей попытки. Карточка прямо сообщает, что
содержимое не разобрано и автозадача не будет создана. Один и тот же revision не запускает
тяжёлый media-анализ каждую минуту: повтор откладывается на шесть часов, а изменение item
снимает блок. Изменение статуса отправляет `inbox-changed`.

Channel adapters page-ят всё activation window до внутреннего safety cap 10 000 native
positions. Public `limit` применяется лишь после decision projection: `new|mixed` не
вытесняются `skipped|task`, summary считает полный authoritative scan, а action заново
разрешает item независимо от текущей страницы. Если native rows больше cap, канал становится
degraded и не публикует частичный список — потеря хвоста молча запрещена.

Удалённые `/api/telegram/inbox*`, событие `telegram-inbox`, store `telegram/inbox.json` и
Telegram-owned triage model не поддерживаются: Inbox до этой архитектуры публично не
выпускался, поэтому aliases, importer и dual-read отсутствуют.

## Identity, leases и stores

Provider identity подтверждает сам provider:

~~~text
Telegram = [1, "api.telegram.org", "bot", bot.id]
GitHub   = [1, "github.com", "repository", repository.id]
~~~

Display username, repository name и присланный клиентом ID security identity не являются.
Durable bindings связывают provider identity со случайным `accountRef`. Все Inbox refs
типизированы и включают owner:

~~~text
messageRef = [1, "message", channel, accountRef, sourceId, messageId]
itemRef    = [1, "item",    channel, accountRef, localBundleId]
scopeRef   = [1, "scope",   channel, accountRef, policyScopeId]
~~~

Каждая list/action операция захватывает immutable lease конкретных
`accountRef + generation + stores`. Switch сначала переводит прежнюю generation в
draining, запрещает новые leases и ждёт уже выданные. Перед HTTP response, durable commit
и внешним side effect выполняется generation check; поздний результат прежнего аккаунта
целиком отбрасывается.

Нативная mutation формы дополнительно присылает увиденный `botId`/`repositoryId` как
optimistic CAS. Server никогда не выбирает по нему namespace: он сначала захватывает
immutable lease, сравнивает provider ID с lease и live connection и только затем пишет.
Поэтому старая вкладка не может очистить rules или сменить service chat уже подключённого
другого account даже пустым payload.

~~~text
telegram/
  account-bindings.json
  accounts/<accountRef>/
    state.json
    archive/<chatId>/YYYY-MM.ndjson
    rules.json
    bot-settings.json
    inbox-state.json

github/
  account-bindings.json
  accounts/<accountRef>/
    archive/issues.ndjson
    ingress-state.json
    rules.json
    inbox-state.json

server/.state/
  telegram-account-creds.json
  github-creds.json
~~~

Files с credentials имеют режим `0600`; они не лежат в prefs и не попадают в browser DTO.
Runtime открывает только account-aware paths и актуальные owner-bound schemas. Flat stores,
старый credential и старые schemas он не импортирует, не читает и не удаляет.

## Activation и решения

Channel marker содержит нативную монотонную позицию и provider-time boundary. Message
eligible лишь внутри сохранённой epoch одновременно по обеим границам. Это не даёт поздней
доставке старого Telegram update или GitHub webhook перескочить activation за счёт новой
локальной sequence.

`inbox-state.json` имеет строгую owner-bound schema v1. Decision содержит collision-resistant
`decisionId`, version, activation epoch и sorted unique `messageRefs`; пересекающиеся
assignments запрещены. Пересборка bundle не меняет смысл решения: полный coverage даёт
`task`/`skipped`, частичный — `mixed`, отсутствие coverage — `new`.

Task/dismiss принимают только непустой точный subset текущих `new` сообщений. Silent
intersection запрещён. Reset возможен только для `skipped` и требует CAS по
`decisionId + version`; task reset невозможен, потому что B24-задача уже существует.
В интерфейсе это действие называется «Вернуть на разбор»: оно переносит выбранные
пропущенные сообщения из «Истории» обратно в «К разбору» и никогда не удаляет B24-задачу.
При stale CAS клиент перечитывает снимок и показывает обновлённую карточку вместо общей
необъяснимой ошибки.

Перед созданием задачи service проверяет B24 readiness ещё до чтения текста канала, затем
непосредственно перед вызовом B24 повторяет plugin/channel gates, generation, revision,
message contents, assignments, project и policy. Durable task decision записывается только
после B24 success. Если B24 ответил успехом, а commit решения стал неопределённым,
автоматический retry блокируется fail-closed до operator reconciliation.

Вложения выбранных сообщений проходят локальный `InboxAttachmentAnalyzer` до model triage
и до вызова B24. Voice/audio распознаются общим `SpeechRuntime`; video/video note дают
транскрипт и до четырёх кадров, а статичная запись без смен сцен — хотя бы первый кадр.
Photo/image и растровые BMP/GIF/JPEG/PNG/WebP document/sticker становятся visual inputs
модели. TXT/MD/Markdown/LOG/CSV/JSON/XML/YAML читаются только как bounded strict UTF-8.
PDF, Office, animation, бинарный текст и прочие неподдерживаемые форматы не считаются
разобранными.

Текст Inbox и содержимое вложений считаются недоверенными. Триаж никогда не вызывает
обычный coding `executor.run`: режим `plan` не является sandbox от prompt injection.
Допускается только явно объявленный `runUntrusted` — одноразовый model-only transport без
coding tools, project/user rules, MCP, hooks, session и workspace. Claude запускается в
отдельном временном cwd с пустым набором tools и strict/safe config; Ollama получает прямой
HTTP model call без toolbox. Codex/Kimi до отдельного безопасного transport остаются
fail-closed (`unsafe_model_provider`).

Visual path не попадает ни в prompt, ни в executor. Сервер разрешает realpath только внутри
`mediaDir/inbox-attachment-analysis`, открывает обычный файл без symlink, проверяет размер,
формат и сигнатуру и передаёт адаптеру лишь `{mediaType, base64}`. Выбранная модель обязана
объявить image modality, а transport — конкретный media type и предел изображений; иначе
результат `unsupported_media`, без молчаливого отбрасывания кадров. Эти capability входят и
в живую readiness автомата: несовместимая выбранная модель не показывается как `ready`.

Лимит одного обращения — 12 вложений и 80 МБ суммарно; Telegram дополнительно ограничивает
один файл 20 МБ. Успешный производный результат кэшируется под hash в `mediaDir`, provider
refs, token и native IDs в prompt, B24 и cache не попадают. Fingerprint учитывает текущие
speech-настройки, поэтому смена модели, языка или hotwords не возвращает старый транскрипт.
Cache ограничен 512 МБ и TTL 30 дней; старые временные каталоги удаляются, а key защищён
от GC до завершения анализа и чтения visual inputs моделью. Автомат всегда fail-closed:
неполный разбор оставляет item человеку. Ручное
создание тоже сначала блокируется; человек может отдельным подтверждением создать задачу
только с доступными исходными файлами, явно принимая, что неразобранное содержимое не
войдёт в постановку.

Автоматическая B24-задача после успешного разбора получает только сформулированную моделью
постановку и source URL (для Telegram — ссылку на сообщение, если Telegram позволяет её
построить). Исходные медиафайлы на Диск и в задачу B24 не загружаются; сырой transcript,
имя модели и служебная подпись Inbox в описание не попадают. Модель, confidence и причина
решения остаются в audit-записи decision. Ручная постановка по-прежнему прикладывает
подготовленные файлы, в том числе при явно подтверждённом обходе неполного разбора.

## Telegram

Страница `/telegram` управляет bot token, `recheck`, `disconnect`, long polling, служебным
личным чатом, нативным архивом и allowlist `чат/тема → проект`. Telegram группирует сообщения
по reply root, затем topic+author, затем chat+author; окно тишины — 600 секунд. Байты вложений
materialize через Bot API лениво: перед автоматическим разбором либо при ручном создании
задачи. До этого в архиве остаётся только provider-owned ссылка на файл.

Тот же allowlist защищает разворот `t.me`-ссылок в B24, тикете конвейера, чате агента и
триаже. Поддерживаются public `t.me/<username>/<message>`, forum-вариант с thread,
private `t.me/c/<internal>/<message>` и comment links; парсер не угадывает тип чата по
одному URL. Resolution идёт в строгом порядке: account archive → временный
`forwardMessage` в служебную личку с немедленным удалением → именованный отказ без текста
и имени запрещённого чата. Scope проверяется до network и ещё раз по найденному message;
ссылка разрешена только для чата/темы, привязанных к требуемому project.

Служебный чат хранится в namespace конкретного bot. Disconnect его не удаляет; возврат к
тому же bot восстанавливает настройку, новый bot ничего не наследует.

Архивные строки без position journal остаются доступной для разворота ссылок историей,
но не попадают в Inbox. Даже поздняя правка такой строки не превращает её в новое
post-activation обращение.

## GitHub Issues

V1 подключает один repository `github.com` и принимает только `issues/opened`. Один issue —
одно сообщение/item, `settleMs=0`; pull requests, comments, edits и attachments не входят
в v1. Allowlist содержит exact repository owner и выбранный B24 project.

`POST /api/github/connect` проверяет repository через authenticated REST, использует
immutable `repository.id`, создаёт управляемый webhook только на operator-owned HTTPS
callback и завершает connection лишь после signed ping на
`POST /hooks/github/:ingressRef`. HMAC-SHA256 проверяется по exact raw body до JSON parse.
Ingress также сверяет hook ID, target/repository ID, generation и delivery GUID.

Dedupe durable по двум ключам: transport `X-GitHub-Delivery` и semantic
`repository.id + issue.id`. После connect/start и затем раз в пять минут bounded REST
reconciliation восстанавливает потерянные webhook deliveries; pull requests отбрасываются.
При недостижимой сохранённой boundary cursor не продвигается и канал становится degraded.
Issues REST возвращает mutable текущую проекцию: обычный edit уже известного issue является
semantic duplicate/no-op. Первый принятый snapshot остаётся immutable, archive sequence и
activation не двигаются, а повторная reconciliation продолжает работу без ложного conflict.

Disconnect немедленно закрывает локальный ingress, затем удаляет только сохранённый remote
hook. Если GitHub недоступен, состояние становится `remote_cleanup_pending`; повторный
disconnect повторяет cleanup. Operator-only `POST /api/github/force-forget` требует
`{"confirmOrphanHook":true}` и допускает оставшийся remote orphan hook. Account data purge
в v1 отсутствует.

До реального connect оператор задаёт `COCKPIT_GITHUB_WEBHOOK_BASE_URL` как публичный HTTPS
base без query/fragment, создаёт fine-grained PAT для одного repository с Metadata read,
Issues read и Webhooks write, затем выбирает B24 project в rules и явно активирует GitHub
на `/inbox`. Код, тесты и установка сами remote webhook не создают.

## Общий автомат

Единственный `InboxAutoTasks` запускается и останавливается в `app.js`. Модель выбирается
в настройке `triageModel` плагина Inbox и применяется ко всем каналам; собственного
provider HTTP client у Inbox нет. `autoTask`, minimum confidence и daily quota принадлежат
точному allowlist scope канала. Подготовленное содержимое вложений и проверенные visual bytes
входят в тот же model call до решения. Нет модели, безопасного transport/image capability,
ошибка разбора/materialize/B24, превышенная
quota или любое сомнение оставляют item человеку.

Runtime читает модель только из `pluginSettings.inbox.triageModel`. Старый Telegram-owned
ключ не импортируется и не используется как fallback; если он сохранился в prefs, это
неактивное неизвестное поле. Штатные изменяемые ворота (`no_model`, `unsafe_model_provider`,
`unsupported_media`, `no_b24`, выключенный плагин) перепроверяются раз в минуту;
пятиминутный backoff оставлен только техническим ошибкам чтения снимка.
Неполный media-анализ конкретного item имеет отдельный шестичасовой cooldown и остаётся
видимым человеку; это не закрывает fair cursor для остальных обращений.

Лимит model calls на один tick не является лимитом глубины очереди: fair cursor каждой
runtime generation продолжает следующий tick после последнего реально проверенного item.
Поэтому постоянная ошибка или низкая уверенность на первых обращениях не закрывает более
глубокие; account switch сбрасывает cursor вместе с generation.

Исторические аргументы, fixture и последовательность работ сохранены в игнорируемых
рабочих файлах `docs/plans/inbox-github-channel-adr.md` и
`docs/plans/inbox-channels-plan.md`; канонический внедрённый контракт находится здесь.
