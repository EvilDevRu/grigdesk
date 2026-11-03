# Каталог общего кода

Перед новой мелкой функцией проверь этот каталог и найди реализацию через `rg` по указанной
папке. Повтор во втором месте — повод сравнить входы, выходы, ошибки и крайние случаи и
вынести общую функцию. Если поведение уже есть в стандартной библиотеке среды, используй её.
Похожие функции с разными контрактами объединяются только с явным параметром или остаются
раздельными; совпадения текста недостаточно.

## Границы

- `shared/<область>/` — контракты и правила одной предметной области, общие для Node и браузера.
  Папка выбирается по владельцу на сервере; потребители не меняют принадлежность правила.
- `shared/lib/<тема>.ts` — мелкие функции без предметной области, доступные во всех средах.
- `shared/node/<тема>.ts` — общие функции только для Node. Браузер не импортирует их напрямую или транзитивно.
- `server/src/lib/` — серверные сервисы, права, файловое состояние, lifecycle и интеграции,
  которым не нужен общий контракт с другими пакетами.
- `web/src/shared/` — представление, DOM, Vue и клиентский lifecycle. Общая арифметика и
  валидация без зависимости от окна могут жить в `shared/`.
- `tests/helpers/<тема>/` и `tests/*/helpers/` — фикстуры и поддержка тестов. Тестовые
  помощники не становятся зависимостью продукта и не кладутся в `shared/`.

Одинаковое имя файла не означает общий модуль: `shared/chat/chatHistoryStepReuse.ts`
содержит протокол, а `web/src/shared/chatHistoryStepReuse.ts` — состояние конкретного
экземпляра Vue store. При переносе разрешай относительный импорт от файла-импортёра;
замена подстроки `shared/` не различает эти границы.

В `shared/` нет импортов собственного кода за его пределами и сторонних пакетов. Node built-ins
разрешены только в `shared/node/`; зависимости пакетов со своим `node_modules` передаются
параметром. Импорт общего модуля не запускает процессы, таймеры или файловые операции.
Синтаксис совместим со снятием типов Node: без enum, namespace и parameter properties.
`shared/package.json` сохраняет ESM-границу. Общего barrel на все области нет: потребитель
импортирует нужный модуль, чтобы не включать посторонние области в сборку.

## Области

| Папка | Содержимое | Среды |
|---|---|---|
| `chat/` | Ход, история и контекст чата, исполнители, модели, настройки и прогноз лимитов | Node, браузер |
| `pipeline/` | Маршруты, граф, ожидание, активность задачи, каталог стадий и триаж | Node, браузер |
| `trackers/` | Контракты драйверов и полки задач с её снимками | Node, браузер |
| `inbox/` | Общий автомат входящих и источник GitHub Issues | Node, браузер |
| `telegram/` | Состояние Telegram, подключение и политика источников | Node, браузер |
| `media/` | Контракты встреч, файлов и обработки речи | Node, браузер |
| `studio3d/` | Контракты 3D, виды версий, операции, поля и цены | Node, браузер |
| `plugins/` | Общие контракты плагинов и установки, нормализация значений установки | Node, браузер |
| `plugins/slots/` | Типы, имена и подписи слотов | Node, браузер |
| `plugins/code/` | Контракт плагина «Код» | Node, браузер |
| `plugins/db/` | Контракты подключений, сессий и результатов баз данных | Node, браузер |
| `plugins/docker/` | Контракт раздела Docker | Node, браузер |
| `plugins/documents/` | Контракт просмотра документов | Node, браузер |
| `plugins/sandboxes/` | Контракт стендов и песочниц | Node, браузер |
| `plugins/showcase/` | Презентации: сцены, цепочки, таймлайн, озвучка и синхронизация | Node, браузер |
| `plugins/ssh/` | Контракты SSH, сессий и доверия ключам хостов | Node, браузер |
| `desktop/` | Описание установки, типы DeviceIdentity/IdentityStore, контракт окон и путь ключа доступа | Node, браузер |
| `i18n/` | Чистый переводчик, descriptors, каталоги RU/EN, LocaleSource и Intl; [контракт](../web/interface-language.md) | Node, браузер |
| `browser/` | Настройки и URL, action decoder и descriptor grigdesk_browser; [контракт](../web/browser-workspace.md) | Node, браузер |
| `client/` | Подключение приложений: версия API, строка привязки, API оболочки | Node, браузер |
| `runtime/` | Папка данных, настройки, готовность, проекты, обновление и версии интерфейса | Node, браузер |
| `web-log/` | Контракты журнала, шаблоны API-маршрутов и уровни диагностики | Node, браузер |
| `lib/` | Независимые от области общие функции | Node, браузер |
| `node/` | Общие функции файлов, потоков и других Node API | Только Node |

## Общие модули

| Модуль | Назначение |
|---|---|
| `web/src/shared/providerModelSelect.ts` | Допуск доступного исполнителя и непрозрачные значения селекта; `ProviderModelSelect.vue` объединяет представление моделей чата, арбитра и плагинов |
| `browser/browserContract.ts`, `browser/browserActions.ts`, `browser/browserTool.ts`, `browser/browserLimits.ts` | Безопасные defaults/URL, распознавание адресной строки и поиск, закрытые actions, provider-neutral tool schema и лимит вкладок |
| `plugins/sandboxes/serviceHost.ts` | Проверка имени хоста стенда без схемы, порта и пути; профиль на сервере и ссылки в браузере |
| `chat/chatPermissionModes.ts` | Маркер явного выбора режима конкретного чата и server-owned action-матрица work tools |
| `pipeline/arbiterConversation.ts` | StopIdentity, лимиты, строгий ответ арбитра, допустимые действия и инвалидирование решения; общий контракт сервера и диалога |
| `server/src/lib/mcpEnvironment.ts` | Окружение MCP: ACP-пары → объект, готовый объект без изменений; используют Kimi host и DeepSeek, пустое поле решает адаптер |
| `lib/errors.ts` | Строковый code, message с fallback и отдельное преобразование Error/String |
| `web-log/webLogContracts.ts` | `sanitizeWebLogError`: безопасные имена, категории и кадры ресурсов сборки до записи исключения |
| `lib/delay.ts` | Пауза с отменой самим signal.reason; обычная Node-пауза — node:timers/promises |
| `lib/text.ts` | UTF-16 границы, лексический порядок, текст unknown, URI и JSON Pointer |
| `node/payloadCache.ts` | Atomic extraction, package lock, полный verifier и kernel fingerprints; политика marker задаётся адаптером |
| `node/payloadArchive.ts` | Индекс и потоковая проверка ZIP; error и ZIP ports передаёт пакет |
| `node/files.ts` | ENOENT→null, временная папка, fsync; read-only modes готового дерева без обхода symlinks |
| `node/seaBuild.ts` | Имя архива Node, SEA config и потоковая загрузка; инструменты сборки остаются у пакетов |
| `node/nodeRuntime.ts` | Манифест Node 24, кэш архива с SHA256, `SEA_FUSE`, запрет tracked output и атомарная публикация файла Б24/DeepSeek/посредника/сервера; шаги конкретного сборщика остаются у пакета |
| `node/seaRuntime.ts` | Проверка готового R без boot: startup для окна, полный хеш для выбора пакета |
| `runtime/serverBinary.ts` | Чистый decoder публичной metadata одиночного ELF: identity, Node/ABI, capabilities, без приватного индекса |
| `node/serverBinaryRuntime.ts` | Пробы ELF, prepare/release и удержание preparation при запуске; [контракт launcher](../server/server-binary.md#launcher-ipc-и-кэш) |
| `node/packagedEnvironment.ts` | Окружение детей SEA: свой Node запасным, Python без pyc, глобальный npm вне R; с готовыми каталогами CLI — общий порядок PATH |
| `node/cliPathOrder.ts` | Синхронный [порядок PATH packaged-запуска](../server/server-binary-path.md) без файлового discovery в раннем графе |
| `node/userCliPaths.ts` | Однократный поиск CLI: явный список, умолчания, nvm без shell rc; совместимый экспорт порядка PATH |
| `node/packageTests.ts` | Выбор *.test.mts и запуск пакетов Б24/DeepSeek через общий сторож памяти |
| `node/hash.ts` | SHA256 байтов и потокового файла; отдельно короткий хеш JSON.stringify без канонизации |
| `node/deepSeekArtifact.ts` | Полный manifest/payload generation и совместимость с явно выбранным Node |
| `node/glmCompatibility.ts` | Прежняя формула compatibility GLM для сервера и установщика ELF |
| `node/binaryInstall.ts` | Общий протокол установщиков: O_NOFOLLOW copy/fsync, inode/SHA, uid/mode receipt, approved CAS и target lock; формат ELF, backup и admission задают потребители ([сервер](../server/server-binary-install.md)) |
| `node/readContainedText.ts` | Ограниченное чтение обычного текста внутри корня без вложенных симлинков; core API 2 и Showcase |
| `node/directoryLock.ts` | Асинхронный mkdir-lock с PID/starttime, ограниченным ожиданием и своим release |
| `runtime/nodeVersion.ts` | Общая чистая политика версий Node без чтения процесса вызывающего |
| `lib/objects.ts` | Проверки прототипа/массива и преобразования unknown; разные политики пустого значения |
| `lib/contractDecoders.ts` | Проверка сетевого JSON с выводом типов и ошибкой вызывающей области |
| `lib/canonicalJson.ts` | Сортировка ключей JSON для отпечатков; порядок массивов сохраняется |

Структуру, внешние зависимости и циклы между областями держит
`tests/docs/shared-layout.test.mts`; он также проверяет недостижимость `shared/node/` из web.
Платформенные глобали общего кода проверяет рекурсивный сторож миграции.

Общие функции одной серверной области не требуют нового межпакетного модуля:
`server/src/lib/showcase/voice/pcm.ts` уже содержит WAV-обёртку и пик PCM16,
которые используют голосовые адаптеры. Сначала переиспользуй такой модуль владельца.
