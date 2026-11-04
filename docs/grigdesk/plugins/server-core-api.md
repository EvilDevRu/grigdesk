# Серверный набор пользовательского плагина

Загрузчик передаёт `options.core` вместе с прежними `config`, `prefs`, `plugin`, `prefix`,
`dataDir`, `lifecycle`. Поддержаны async и callback/done default-export обычного Fastify plugin.
Используется отдельный Fastify router: scope получает живые ссылки на декораторы приложения,
общий auth guard оболочки закрывает API, static и WebSocket до dispatch. Для действий только человека автор проверяет
`request.authKind === 'session'`. Это доверенный код процесса, не sandbox ОС.

Реализация: `server/src/modules/plugins/{core,providerCapabilities,changes,lifecycle,index}.ts`.
Примеры для автора — [plugins/README.md](../../../plugins/README.md).

## Функции и исполнители

| Поле core | Поведение |
|---|---|
| `getProviders(type)` | Асинхронно читает singleton реестра исполнителей. Только строгий тип `3d` и capability `studio3d`; остальные типы дают `[]`. |
| `emit(event, data?)` | Посылает `plugin-event` в общий `/api/events`; id и envelope принадлежат ядру. |
| `withPathLock(key, task)` | Прямая функция очереди ядра по ключу внутри процесса. |
| `acquireKernelFileLock(options)` | Прямая функция kernel flock ядра; освобождение через `await lock.release()` в finally. |
| `documents` | Только bound `roots`, `resolveAbsolute`, `read`, `readAsset` того же DocumentReader, который создало приложение. |
| `parseByteRange(header, size)` | Штатный разбор одного Range: `{start,end}`, `'invalid'` или `null`. |

Новый реестр, очередь и reader не создаются. Поздно добавленные корни reader видны сразу;
методов добавления корней нет. Отсутствие reader или SSE в изолированном подключении
выявляется явной ошибкой при вызове. Flock сохраняет штатные проверки identity и протокол
владения; lock-файл не удаляют. Документы сохраняют проверки корней, ссылок и открытого fd.

Фасад исполнителя содержит только публичные данные и методы Studio3dProvider. Не передаются
поля адаптера, probe/auth/login и credentials. Публичные поля копируются и замораживаются,
методы вызываются с исходным `this`; необязательные методы остаются необязательными.
`snapshot()` выдаёт frozen `{accountKey,billingUrl}`. WeakMap фасада хранит исходный снимок,
а `isCurrent/balance/history` (аргумент 0) и `prepare/send/poll` (аргумент 1) переводят токен
обратно внутри ядра. Необязательный undefined сохраняется. Чужой, скопированный или
восстановленный из JSON токен даёт TypeError до вызова исполнителя. Кэш одного core сохраняет
фасад между запросами к реестру; токены другого core или исполнителя непригодны.

## События

В SSE всегда `event: plugin-event` и JSON `{pluginId,event,data}`. Отсутствующий data — null.
Имя автора непустое, не длиннее 128 символов, без управляющих U+0000–001F/U+007F; нарушение
даёт TypeError до broadcast. Вложенный pluginId или event в данных не заменяет envelope,
переводы строк в JSON не создают SSE-фрейм. У core нет нового raw broadcast API.
Прежние root decorators остаются доступны доверенному коду: гарантия относится к core.emit.
Выключение не гасит emit и не останавливает фон; это ответственность плагина.
Клиент использует один общий SSE на вкладку; новая подписка окна здесь не вводится.

## Допуск и подпись перезапуска

Enabled при boot загружает сервер и страницу. После этого toggle синхронно меняет отдельный
enabled gate после успешной записи prefs. Новый HTTP/static/upgrade получает 404
`{error:'plugin_disabled',message:'Плагин выключен.'}`; повторное включение открывает тот же
runtime. Уже принятые streams/WS и фон не обрываются. Loaded не сбрасывается.

Dormant при boot не импортируется; первое on ждёт готовности собственного сервера
до записи prefs и открытия admission. Обновление и откат подключают новый router сразу. GET каталога и успешный toggle возвращают актуальный needsRestart:
false для системного, здорового загруженного, dormant-off и пакета без кода/страницы;
Обычное первое включение и завершённая замена дают false. Неудачный import/register
или незавершённая публикация runtime могут дать true. Несовместимый api и конфликт двух входов дают false: рестарт не исправляет
пакет. Blocked остаётся recovery-ошибкой. Ручная правка prefs меняет gate после рестарта.

Store принимает boolean needsRestart из ACK и GET, включая снятие ожидания по false.
GET true восстанавливает «Ждёт перезапуска» после загрузки вкладки. Если старый сервер не
вернул поле ACK, действует прежний fallback. Старой вкладке при обновлении ядра может
понадобиться перезагрузка для верной подписи. ServerError показывается как обычный текст
через UiInlineMessage и в обычной, и в узкой touch-панели.

Необязательные `lifecycle.onEnable()` / `onDisable()` — уведомления после принятой реальной
смены, без вызова при boot и повторе значения. Они планируются после commit/gate update
до ожидания afterCommit, их Promise не удерживает HTTP. Отказ журналируется безопасным
предупреждением с id/фазой. Транзакционные действия выполняются в prepareChange.

## Проверка настроек

Необязательный `lifecycle.prepareChange(change, signal)` получает клонированный частичный
`{enabled?;values?}`. Values отфильтрованы по схеме, числа нормализованы, defaults добавлены.
Placements-only не запускает validator. Возврат — undefined либо полный PluginTransition:
синхронный не бросающий commit, async rollback и afterCommit. Форму проверяют до prefs.write.

Порядок: prepare → свежий patch prefs → write → sync commit → gate/уведомление → afterCommit.
До commit действующий runtime не меняется. Ошибка после prepare до commit вызывает один
rollback; gate и уведомления не меняются. Известная 4xx-ошибка с code/message передаёт
понятный отказ; code состоит из строчных латинских букв и подчёркиваний. Неизвестный отказ
даёт 409 plugin_change_rejected, «Плагин отклонил изменения настроек.» без текста исключения.

Prepare ограничен 5000 мс, затем 409 plugin_change_timeout и abort. Пока исходный Promise
не завершится и поздний transition не подтвердит rollback, reservation не освобождается.
Поздний reject обработан. Повторная подготовка или replacement получают busy; при вечной
подготовке или неудачном rollback новый запрос сообщает о необходимости перезапуска.
AfterCommit ждут максимум 5000 мс, затем возвращают успех с уже записанными prefs и warn.
Reservation остаётся до settlement afterCommit; его отказ не отменяет сохранение.

Settings/toggle одного runtime и replacement взаимно исключены от prepare до cleanup.
Другой плагин и placements-only могут писать независимо; patch собирается из свежих prefs.
Apply сохраняет settings перед enabled двумя запросами: отклонённый toggle не отменяет
ранее принятые settings. Dormant не запускает проверку кода, который ещё не загружен.

## Замена и серверный вход

Replacement-фаза проверяется до enabled: replacing/installed/blocked сохраняют прежние
HTTP-коды. Reverted снимает запрет замены, но не включает выключенный gate. Installed/blocked
допускают запись prefs без validator и уведомлений старого кода и не открывают routes.
Off не предоставляет lease: управляемый server без prepareReplace отдельно закрывается
через Fastify onClose. После installed refresh подключает новый сервер и панель без
перезапуска; [подробности горячего runtime](plugin-hot-runtime.md). Резерв следующего
запуска сохраняется для runtime после неудачного import/register.
Подробности — [runtime lease](plugin-install-runtime.md).

В пакете необязателен один `server.js` или `server.ts`. Общий selectPluginServerEntry сохраняет
hasServer и выбирает serverEntry; scanner использует прежний access, installer — lstat/isFile
после проверки дерева. Оба файла дают serverError с требованием оставить один вход: каталог
сохраняет карточку, загрузчик пропускает код и страницу, installer даёт manifest_invalid.
Включение конфликтного пакета — 409 plugin_server_conflict без записи; выключение допустимо.
Server.ts также считается sensitive file, в том числе внутри web.

ImportRuntimeModule получает выбранный путь. Native TypeScript работает в source и packaged/SEA
через существующий bridge: стираемые типы, относительные imports с расширениями и TLA.
Enum, namespace с runtime-кодом и parameter properties требуют отдельной компиляции автора.
Версия api, разбор оконного module и раздача его файлов этим контрактом не меняются.

Проверки: plugin-core, plugin-runtime, plugin-changes, plugin-server-entry, sea-plugin-import
в tests/server и plugin-runtime-settings.component в tests/web. Настоящий SEA проверяется
отдельным tests/server/sea/plugins.test.mts; bridge под обычным Node его не заменяет.
