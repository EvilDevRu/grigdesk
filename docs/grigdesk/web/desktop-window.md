# Локальное окно GrigDesk

Главный процесс `desktop/src/main.ts` загружает локальный веб GrigDesk через модули
подключения, настроек, защиты и входа. Модульные проверки, TypeScript и сборка прошли.
Сквозная проверка настоящего dev Electron подтверждает окно, вход и SSE:
[устройство проверок](../testing/desktop-window-e2e.md).

## Подключение и настройки

Профили и настройки v2 описаны в [контракте трубы](client-pipe.md). Файл userData/settings.json
содержит геометрию, profiles и selected; версия 1 мигрирует в местный профиль. Отсутствие
описания установки не мешает удалённому подключению. Порядок старта — в [отдельном документе](desktop-startup.md).

Сохранения атомарны и последовательны, файл имеет 0600, личный каталог 0700. Ссылки и чужие
каталоги отвергаются. У главного окна собственная `window`, у карточек общая `surfaceWindows.task`; localStorage разделён origin
каждого профиля.

## Политики и адаптеры Electron

`windowSecurity.ts` использует реальные типы Electron через import type; его unit не
запускают Electron. Опции окна задают `persist:grigdesk-local`, sandbox, contextIsolation
и webSecurity. Node, preload, webview и spellcheck выключены; devTools разрешены только
вне упаковки. Главное окно изначально скрыто.

Свои HTTP-навигации проходят. Внешние HTTP(S) отменяются и получают канонический адрес
для системного браузера; credentials и прочие схемы, включая blob своего origin,
отклоняются. Redirect ограничивается главным фреймом, подфреймы сохраняют браузерное
поведение. Собственная ссылка в новое окно получает безопасные preferences, общую
session и show:true; её features не меняют эти опции. Потомки синхронно получают защиту
и onChild, повторное подключение обработчиков исключено.

Главному фрейму своего origin разрешены notifications, clipboard-sanitized-write и fullscreen.
Media требует явного непустого набора только audio. Адаптер check использует отдельный
requestingOrigin, request — requestingUrl и mediaTypes; противоречащий securityOrigin
отклоняется. Video, неизвестные permissions и media без типа запрещены.

`configureSession` сначала устанавливает единственный фильтр запросов, затем ждёт
очистку serviceworkers и cachestorage выбранной сессии. LocalStorage не очищается; прежние cookie127.0.0.1 удаляются, кроме grigdesk_pipe. Блокируется только свой `/sw.js`, также с query; другие имена SW этот фильтр
не блокирует. Ошибка очистки передаётся caller. Сквозной тест подтверждает отказ
настоящей регистрации `/sw.js`, также с query, при работающей обычной HTTP-сети.

## Связь и меню

Ключ местного сервера читает autoLogin.readWindowKey с проверкой владельца, прав, типа,
O_NOFOLLOW и ограничением размера. Сессию держит upstream трубы, renderer получает только
секрет трубы. TLS-личность устройства хранится запечатанной safeStorage. При потере связи
рабочий документ сохраняется, состояние и повторы принадлежат shellApi.

Главное окно и настройки используют прежние защищённые предпочтения и контекстное меню.
Навигация, дочерние окна, разрешения и запрет SW принимают набор origin труб текущего запуска;
произвольный loopback-порт не становится доверенным. Проверки: window-security, menu,
startup-controller и client.e2e.

`menu.ts` возвращает шаблоны «Файл», «Правка» и «Вид» с русскими подписями ролей,
масштабом и полным экраном, без DevTools. Строка меню в окне постоянно скрыта,
одиночный Alt заблокирован; [кнопки окна встроены в топбар](desktop-titlebar.md).
Действие «Файл → Настройки…» передаёт `grigdesk:open-settings` в главный документ
и открывает [общий модал настроек](desktop-settings-window.md). Accelerator Ctrl+Alt+S объявлен
с `registerAccelerator: false`; действие обрабатывает `before-input-event` по физическому
KeyS в главном окне, до обработчика страницы и xterm.
Контекстное меню следует editFlags и может
добавить копирование адреса ссылки. Разделитель появляется только между непустыми
группами. Пустой шаблон проверяется перед popup; Menu и clipboard подключает main.


## Главный процесс и сборка

Старт идёт через заставку, supervisor сервера и ворота показа — [старт окна](desktop-startup.md).
Сразу после single-instance lock установлен обработчик второго экземпляра: до показа он
фокусирует заставку, после — главное окно с его текущим модалом, во время выхода ничего не
делает. Аргументы второго экземпляра не меняют подключение и настройки.

До первого loadURL главное окно получает UA `GrigDeskSettings/1 GrigDeskWindow/main`.
Зарегистрированная карточка получает роль `surface` до первого loadURL и собственный
канонический вход `/?surface=task&id=…#/surface`; query сам роль не включает.
[Окна задач](feature-windows.md) используют тот же partition, guards и protected pipe.
Настройки открываются в своём документе по событию
`grigdesk:open-settings`. Обычные дочерние окна получают UA сессии без маркеров.
Защиту обеспечивает общий guard.

Сохраняются getNormalBounds/isMaximized главного окна после показа. Выход, SIGTERM и заставка
описаны в [порядке старта](desktop-startup.md). Повреждение встроенного пакета даёт фатальный
диалог «Установка повреждена» и выход; страница удалённой машины для этого не загружается.

Защищённый backend проверяет electronSealer при привязке: gnome_libsecret или
kwallet/kwallet5/kwallet6; basic_text/unknown не допускаются. Прежний модуль storageProtection удалён: отсутствие backend не мешает открыть экран машин без ключа.

Версия desktop —0.1.0. Build собирает main.cjs через esbuild в staging, Electron external,
копирует icon.png и dist/splash. Встроенный web запечатан в resources/ui. Dist выпускает
Linux x64 AppImage. Fuses включают шифрование cookie и выключают runAsNode, NODE_OPTIONS
и CLI inspector; они проверяются у linux-unpacked и извлечённого ELF AppImage.
AppImage без FUSE проверяется через --appimage-extract-and-run.

## Установка и ярлык

`grigdesk-ctl desktop install` требует уже собранного
`desktop/release/grigdesk-desktop-<версия>-x86_64.AppImage` текущей версии manifest.
Node берётся из явного GRIGDESK_NODE_DIR либо PATH; установка не читает .env и не
запускает сборку. При отсутствии файла команда возвращает 1 с подсказкой
`npm --prefix desktop run dist`, сохраняя прежнюю установку.

Окно ставится как программа копии: общий путь `deploy/lib/desktop-app.sh` —
`<физический корень копии>/bin/grigdesk-app`, тот же AppImage без расширения в имени. Так все
исполняемые файлы, как и в готовом архиве выпуска, лежат в `bin/`. `runtime.json` и метка
`data-home` остаются в `$XDG_DATA_HOME/grigdesk/desktop` (пустой XDG_DATA_HOME — HOME/.local/share).
Перед заменой файла install пишет `runtime.json` версии 1 установленного сервера; после замены
явная `GRIGDESK_HOME` сохраняется в `home` descriptor версии 2
([описание установки](../server/desktop-owned-server.md)). Копирование
идёт в скрытый `bin/.grigdesk-app.XXXXXX`, chmod 755, затем атомарный mv. При отказе удаляется
только собственный temporary, прежний файл сохраняется. После успешной замены install удаляет
окно с прежнего места `$XDG_DATA_HOME/grigdesk/desktop/grigdesk-desktop.AppImage` (открытое
старое окно продолжает работать) и вызывает `deploy/shortcut.sh refresh`: существующие файлы
ярлыка получают новый Exec, отсутствующие не создаются; отказ ярлыка только печатает
предупреждение. `remove` удаляет окно в `bin/`, прежний файл, `runtime.json` и метку,
сохраняя профиль и настройки. `status` печатает `installed`, `path` и `runtime` через TAB;
status, remove и неизвестная команда не требуют Node, неверная команда возвращает 2.

С установленным окном и его `runtime.json` ярлык ведёт прямо в `bin/grigdesk-app`: окно само
поднимает сервер. До установки (переходный режим) ярлык ведёт в `deploy/shortcut.sh open`:
скрипт вызывает `bin/grigdesk-ctl open` с каталогом Node первым в PATH. Команда запускает
установленный файл отвязанным процессом с единственным
`--grigdesk-url=http://127.0.0.1:<порт>/` до обращений к systemd или сети, затем при необходимости
запрашивает запуск службы. Окно показывает заставку и подключается само. Если окна нет,
CLI предлагает `grigdesk-ctl desktop install`, но всё равно запрашивает запуск сервера. Отсутствие
графического сеанса также не отменяет этот запрос. Отказ показывается уведомлением с причиной
из stderr. Файл `.env` находится в папке данных (или задан `GRIGDESK_ENV_FILE`).
Ключ окна из `.env` передаётся отдельно, остальное содержимое файла не экспортируется.
При вызове из cgroup службы сторож требует `--force` ещё до внешних эффектов.

Проверки установки и лаунчера используют копии CLI и фальшивые файлы/команды в
собственных HOME/XDG, включая пробелы и кириллицу; настоящая установка не проверялась.

Проверки: `tests/desktop/{connection,settings,window-security,menu,auto-login}.test.js`,
`client-runtime.test.js`, `build-contract.test.js`
через memory guard. Отдельная проверка `tests/desktop/e2e/isolation.test.mjs` подтверждает
одноразовые HOME/XDG, D-Bus, GNOME Keyring, Xvfb и уборку собственных процессов.

CLI и ярлык: `tests/server/{desktop-install-script,launch-script,shortcut-script}.test.js`,
`tests/cli/{entry,server,open,relay-status,cli-link,readiness}.test.mts`.
Новый текст заставки появляется после пересборки и установки окна человеком.


## Сохранённые модули прежнего клиента

identity.ts и selfSignedCert.ts теперь обслуживают ключ полного клиента: EC P-256,
самоподписанный сертификат и electronSealer. node-link/PhoneEmulator проверяют прежний v1.
Mobile renderer, preload и прежние IPC/media entrypoints не возвращаются.

## Команды проверок

```bash
NODE_TEST_MAX_RSS_MB=4096 bash tests/run-node-tests-safe.sh \
  --test-concurrency=2 --test tests/desktop/*.test.js
```

E2E: [окно](../testing/desktop-window-e2e.md), [старт](../testing/desktop-startup-e2e.md),
[готовый пакет](../testing/desktop-window-package.md). Проверяются sandbox, отсутствие Node,
дочерние окна, ссылки/302, разрешения, сохранность документов, single-instance и первый кадр.
Настоящие микрофон, уведомления Linux, фокус оконного менеджера и Wayland принимает человек.
