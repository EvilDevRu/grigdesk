# Режимы разрешений Codex в чате

Адаптер знает шесть ID по образцу меню Claude. Для codec CLI 0.164.0 допущены два
профиля песочницы; остальные не предлагаются и получают `mode_unavailable` при прямом
запросе. Пустое legacy-значение означает `auto`, неизвестный ID отвергается. Отдельный
общий тумблер «Режим „Хост“» включает проверенный полный доступ на установке 0.167.1
(см. [Режим «Хост»](#режим-хост)); в меню режимов он не появляется.

| ID | Native профиль | Доступность |
|---|---|---|
| `auto` | workspace-write, on-request, auto_review | Прежний default; effective handshake обязателен |
| `dontAsk` | workspace-write, never, user | После проверки identity/schema и managed requirements |
| `bypassPermissions` | Кандидат danger-full-access, never, user | Недоступен как выбор чата: полный доступ даёт только настройка «Хост» |
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

## Режим «Хост»

Общий тумблер `allowHostAccess` в настройках исполнителя Codex (по умолчанию выключен)
включает полный доступ для всех обычных чатов. Включение требует явного подтверждения
(`confirm.on`); сервер отвергает запись без точного `confirmed=true` кодом
`confirmation_required`. Отдельного переключателя, выбора Host и повторного согласия
в каждом чате нет. Основание допуска — доверенная серверная настройка, а не marker
чата, текст запроса или присланный JSON: boolean в теле хода права не повышает.

Эффективный профиль Host — `danger-full-access / never / user`. Он перекрывает выбор
меню (`auto`/`dontAsk`) общим профилем; сохранённый выбор чата не перезаписывается и
возвращается при выключении Host. Host не добавляется в `modes()`, в
`requiresExplicitSelection` и в default чата. Без sandbox-границы не возникают прежние
запросы её расширения, поэтому `never/user` описан честно: вопрос перед каждой записью
вне workspace и автоматическая проверка действий не гарантируются. Обязательные
подтверждения надзорных инструментов GrigDesk (SSH/БД) сохраняются; автоматического
sudo нет.

Допуск Host проверяет выбранную установку: отдельная запись admission для версии
0.167.1 с проверенным fingerprint схемы и codec revision. Legacy-допуск 0.164.0 Host
не объявляет; неизвестная версия, несовпадение схемы, запрет managed policy или
подменённый effective readback дают явный `mode_unavailable` до рабочего turn, без
молчаливого fallback на другую установку или песочницу. Managed requirements
сверяются с эффективным tuple, а не с запрошенным режимом меню, и перечитываются
перед каждым send. Возврат в песочницу при Off допускается на 0.164.0 и 0.167.1.

Обычный чат владеет собственным transient user scope приложения в обоих профилях
(общий helper `providerInstall/ownedProcessScope.ts`, извлечённый из Qwen Host).
Подготовка читает `/proc/self/cgroup`, требует отдельный user app unit и доступный
user bus; отсутствие менеджера даёт явную причину отказа (`codex_host_scope_unavailable`),
а не слабый fallback. Scope создаётся с `KillMode=control-group`, `SendSIGKILL=yes`,
`BindsTo`/`After` app unit; сигналы идут только сохранённому собственному UUID, поиск
по имени/чужим unit запрещён. Имя scope в snapshot/HTTP не публикуется.

Закрытие ordinary-сессии подтверждённое: exit CLI не освобождает запись и слот, пока
scope не подтверждён пустым (`inactive`/`not-found` и пустая собственная cgroup).
Ошибка/таймаут cleanup удерживает entry с видимой причиной (`cleanupError`) и допускает
повтор; новый профиль не открывается до успешного закрытия прежнего. Параллельные
close одного поколения делят одну попытку. HTTP close/reset/delete при отказе отвечают
typed `process_cleanup_failed` (503) до сброса памяти/удаления истории. Сохранение
настройки не прерывает активный ход: текущий ход сохраняет прежний профиль, следующий
получает новый после подтверждённого закрытия несовместимого процесса. Resume сохраняет
переписку, модель, effort и sessionId; совершённые внешние действия не объявляются
отменёнными.

Эффективный профиль текущего хода доставляется отдельным optional `permissionProfile`
снимка (`id/sandbox/approvalPolicy/approvalsReviewer/confirmed`) через active/SSE;
подтверждение приходит после readback живого runtime, а не из настройки следующего
хода. Реестр отдаёт `fixedPermissionProfile` (презентация следующего хода) при
включённой настройке; окно показывает readonly «Хост» в прежнем месте селекта, без
новых chat controls. Старый snapshot без поля означает неизвестные права, а не
подтверждённые.

## Выбор и доставка

`defaultPermissionMode=auto` явно задаёт Codex default. У остальных исполнителей
остаётся прежний fallback. `permissionModeSelectionPolicy=preserve-explicit` сохраняет
ранее выбранный недоступный ID; каталог loading/error не превращает plan в auto.
UI и обычная отправка, compact и outbox используют один resolver.

Полный доступ обычного чата даёт подтверждённая настройка «Хост», а не marker чата.
Прежний `modeSelection={provider,id,revision,chatId}` для `bypassPermissions` сохранён
как legacy-проводка, но самостоятельного допуска при выключенной настройке не даёт:
старый marker можно хранить без миграции, для Host он игнорируется. Повреждённый HTTP
marker по-прежнему отвергается общей валидацией (400) без предоставления прав.
Descriptor запрещает сохранять bypass в default новых чатов; смена провайдера очищает
marker. Mode и marker образуют одну CAS-группу против старого PUT.

При включённом Host общий resolver отправляет допустимый wire-mode `auto` без marker
и без per-chat выбора; сохранённый sandbox preference чата не перезаписывается и
возвращается при Off. Send/compact/outbox используют один resolver. Snapshot outbox
фиксирует mode; принятый ход сохраняет свой snapshot. В active run metadata хранится
эффективный `permissionProfile`, подсказка селекта различает действующие права
текущего хода и настройку следующего.

## Вопросы и предел проверки

`item/tool/requestUserInput` проходит существующую structured-карточку. Ответы
связываются по native `question.id`, одинаковые header их не смешивают. `isOther`
разрешает ограниченный свободный текст рядом с вариантами, `options:null` — текст.
Ответ имеет `{answers:{[id]:{answers:string[]}}}`. `isBlocking=false` не удерживает
канал уточнений. Deprecated `autoResolutionMs` не даёт автоматического ответа.

`isSecret=true` отклоняет весь запрос до UI/waiter и получает ровно `{answers:{}}`.
Суточный срок direct waiter отменяет карточку и поздний ответ; resolved/stop/конец
хода/закрытие процесса снимают только своё ожидание. Request ID различает number/string.

`request_user_input_async` использует другой канал: `agentMessage` с `delivery=async`
и `questions`. Его карточка не блокирует ход, ответ возвращается через `turn/steer`,
а не RPC response. Подробности — [асинхронные вопросы](codex-async-questions.md).

Настоящий CLI с loopback Responses подтвердил shell/patch контрпримеры strict modes,
workspace/sibling markers dontAsk/bypass, два send dontAsk через wrapped adapter и cleanup.
Отдельная native-проба показала: пустой список terminals после cleanup не препятствует
позднему marker отсоединённого процесса bypass; поэтому этот профиль как выбор чата не
допускается. Полный доступ обычного чата даёт только настройка «Хост» с собственным
scope и подтверждённым закрытием.

Режим «Хост» проведён нативно на `codex-cli 0.167.1` (Linux, user systemd): sibling-эффект
вне roots, detached normal/setsid/double-fork и их отзыв после close, пустая captured
cgroup, foreign sentinel жив, graceful и авария synthetic owner через BindsTo, отказ
недоступного bus до turn, resume того же thread и оба перехода off→on→off через пул.
Схема установленной установки совпала с admission fingerprint. Подробности и границы —
[native-допуск «Хост»](../testing/codex-permission-mode-fixtures.md#native-допуск-режима-хост).
Fake RPC отдельно проверяет очередь, drift, scope и readback. Живой model acceptance и
качество настоящего Auto-review нативными пробами не подтверждаются; четыре недопущенных
режима меню не объявлены реализованными.
