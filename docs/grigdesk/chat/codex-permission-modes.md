# Режимы разрешений Codex в чате

Адаптер знает шесть ID по образцу меню Claude. Для codec CLI 0.164.0 допущены два
профиля; остальные не предлагаются и получают `mode_unavailable` при прямом запросе.
Пустое legacy-значение означает `auto`, неизвестный ID отвергается.

| ID | Native профиль | Доступность |
|---|---|---|
| `auto` | workspace-write, on-request, auto_review | Прежний default; effective handshake обязателен |
| `dontAsk` | workspace-write, never, user | После проверки identity/schema и managed requirements |
| `bypassPermissions` | Кандидат danger-full-access, never, user | Недоступен: cleanup не отзывает detached effect |
| `manual` | Кандидат read-only/untrusted/user | Недоступен: allow-rule пропускает Bash без вопроса |
| `acceptEdits` | Кандидат workspace-write/user | Недоступен: Bash и новый `.env` могут не требовать вопроса |
| `plan` | Целевой read-only без сети | Недоступен: не доказан overlay MCP/hooks/apps/auth route |

`dontAsk` относится к native approvals. Вопросы агента и обязательные подтверждения
SSH/БД сохраняются. Режим не заменяет надзорный broker. В `auto` неожиданный ручной
command/file/permissions request по-прежнему закрывает собственный app-server;
native denial не превращается в ручной override. Разовые codecs подготовлены и
проверены отдельно, но ручные режимы ими не включаются.

## Подготовка и повторное использование

Compile-time admission содержит revision, codec, точную версию и fingerprint схемы.
Артефакт, env или UI не могут включить недопущенный профиль. Каталог перечитывает
managed policy; запуск независимо проверяет её заново. `requirements:null` и nullable
allowed-списки не добавляют ограничений; пустой список запрещает выбор. Неправильная
структура не трактуется как отсутствие требований.

`prepareRuntime` выдаёт frozen opaque handle. Общий external CLI wrapper связывает
его с одним выбранным executable/окружением и использует их для native settings,
run/open и последующих send. Fingerprint включает identity, schema, требования,
native config, roots, настройки, work-tool policy и окружение маршрута авторизации.
Ключи объектов упорядочены: порядок сериализации Rust map не означает drift.

Handle не хранится в истории, SSE или HTTP. Перед spawn проверяются brand, roots,
выбор и identity; новый mode без handle не запускается. На каждом send нового профиля
снова читаются требования/config, effective sandbox сверяется до turn. Профиль явно
задаётся на start/resume/turn; изменённый fingerprint исключает reuse.

RPC config использует dotted keys `sandbox_workspace_write.*`. Native readback не
перечисляет неявно разрешённый `cwd` в `writableRoots`; проверяются полное множество
с добавлением cwd, сеть и tmp-флаги. Лишний root не принимается. До первого turn
нового thread rollout может отсутствовать: первый effective ответ берётся из start,
последующие send дополнительно сверяют resume. Model/effort сохраняются.

Перед сменой профиля пул вызывает optional `prepareTransition`. Codex запрашивает
очистку native terminal sessions и подтверждает пустой список. Отказ/таймаут не
позволяют открыть следующий профиль. Close ждёт фактического завершения своего
процесса, при необходимости отправляет KILL через существующий process wrapper.
Это проверка учтённых native terminal sessions, не доказательство отзыва произвольного
отсоединённого процесса, созданного внешней программой.

Служебный `workspaceAccess` сохраняет прежние never/user, roots/network/tmp;
untrusted runner и Factory не получают чатовый mode.

## Выбор и доставка

`defaultPermissionMode=auto` явно задаёт Codex default. У остальных исполнителей
остаётся прежний fallback. `permissionModeSelectionPolicy=preserve-explicit` сохраняет
ранее выбранный недоступный ID; каталог loading/error не превращает plan в auto.
UI и обычная отправка, compact и outbox используют один resolver.

Полный доступ требует `modeSelection={provider,id,revision,chatId}` с revision 1.
Чужой или повреждённый marker отвергается сервером до рабочего spawn. Legacy полный
доступ без marker отображается/отправляется как auto. Descriptor запрещает сохранять
bypass в default новых чатов. Новый/клонированный чат не получает чужой marker;
смена провайдера очищает его. Reload того же чата сохраняет явный выбор. Mode и marker
образуют одну CAS-группу против старого PUT.

Проводка явного полного доступа подготовлена, но его admission выключен.
Snapshot outbox фиксирует mode вместе с marker. Изменение выбора отзывает ещё не
подтверждённую автоматическую отправку с полным доступом; нужен новый явный send.
Принятый ход сохраняет свой snapshot. В active run metadata хранится его mode,
подсказка селекта различает действующие права и выбор следующего хода.

## Вопросы и предел проверки

`item/tool/requestUserInput` проходит существующую structured-карточку. Ответы
связываются по native `question.id`, одинаковые header их не смешивают. `isOther`
разрешает ограниченный свободный текст рядом с вариантами, `options:null` — текст.
Ответ имеет `{answers:{[id]:{answers:string[]}}}`. `isBlocking=false` не удерживает
канал уточнений. Deprecated `autoResolutionMs` не даёт автоматического ответа.

`isSecret=true` отклоняет весь запрос до UI/waiter и получает ровно `{answers:{}}`.
Суточный срок direct waiter отменяет карточку и поздний ответ; resolved/stop/конец
хода/закрытие процесса снимают только своё ожидание. Request ID различает number/string.

Настоящий CLI с loopback Responses подтвердил shell/patch контрпримеры strict modes,
workspace/sibling markers dontAsk/bypass, два send dontAsk через wrapped adapter и cleanup.
Отдельная native-проба показала: пустой список terminals после cleanup не препятствует
позднему marker отсоединённого процесса bypass; поэтому этот профиль не допускается.
Fake RPC отдельно проверяет очередь, drift, scope и readback. Это offline-проверка:
живой model acceptance, произвольные detached children и полная матрица внешних
native путей не подтверждены. Четыре недопущенных режима не объявлены реализованными.
