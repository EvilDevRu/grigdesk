# Валидация workflow выпуска

`.github/workflows/grigdesk-release.yml` выпускает комплект только по ручному запуску
`workflow_dispatch` (Actions → «Релиз GrigDesk» → Run workflow). Триггер `push` отсутствует:
отправка коммитов и тегов не запускает сборку и публикацию.
Однако невалидный workflow может создать запись `failure` после push, без единого job
и без журналов сборки. При включённых уведомлениях Actions GitHub присылает об этом письмо.

Контекст `runner` доступен внутри шагов, но запрещён в `jobs.<job_id>.env`.
Поэтому `${{ runner.temp }}` в окружении задания ломает проверку всего workflow
до запуска runner. Разрешённые места перечислены в
[контракте контекстов GitHub](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability).

Первый шаг workflow получает `$RUNNER_TEMP` из окружения shell и записывает пути
`GRIGDESK_TEST_DEEPSEEK_ROOT`, `GRIGDESK_ARTIFACTS_DIR` и `GRIGDESK_DEEPSEEK_NODE_CACHE`
в `$GITHUB_ENV`. Следующие шаги получают абсолютные пути в своей временной папке runner.
Выражения `${{ runner.temp }}` в `steps[*].env` для ключей публикации допустимы.

После переименования CLI задач сборка устанавливает зависимости `tracker/`;
прежней папки `b24/` в checkout нет. Порядок установки server/web/mobile/tracker/relay/deepseek/desktop
и закреплённые версии всех четырёх Actions, включая загрузку артефактов, проверяются контрактными тестами.

`mobile ci` выполняется до серверных тестов: общая программа TypeScript включает
`tools/mobile-phone`, который импортирует Vite, Vue-плагин и Playwright из зависимостей
мобильного клиента. На чистом runner отсутствие этого шага даёт TS2307 ещё до тестов.

До native-проверок workflow устанавливает системный `bubblewrap` и выполняет настоящую
пробу read-only mount/PID-песочницы. GLM gate запускает shell уже при boot; отсутствие
backend даёт отказ до модели даже при успешных metadata/verify. Непригодная песочница
останавливает workflow на ранней пробе, до дорогих сборок.

Ubuntu runner ограничивает создание user namespaces через AppArmor: одной установки
bubblewrap недостаточно (`setting up uid map: Permission denied`). Workflow загружает
отдельный профиль для `/usr/bin/bwrap` с разрешением `userns`, затем повторяет функциональную
пробу. Это настройка одноразового runner по [контракту Ubuntu](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces).

Тесты записи требуют также системные `ffmpeg` и `ffprobe`: Playwright поставляет собственный
ffmpeg для захвата, а проверка и обрезка клипа вызывают системные команды. Workflow явно
устанавливает пакет `ffmpeg` и проверяет обе команды до тестов.
Тот же шаг устанавливает и проверяет `ripgrep`: native shell parity использует настоящий
`rg` внутри рабочей папки. Отсутствие команды даёт отказ сценария до проверки разрешений.

После подготовки pinned dependencies workflow явно материализует проверенный snapshot
Harness через `materializeDeepSeekSnapshot`. В Git хранится только manifest, patches
и лицензии; `upstream/` — игнорируемый кэш. Без подготовки холодная сборка тестового ELF
отказывает ещё до запуска модели, хотя на машине с готовым generation cache проверки
могут проходить. Затем отдельный `deepseek-binary-cache-root.test.js` собирает и проверяет
общий candidate, web/ACP и чат до большого серверного набора. Ошибка builder включает
последние 8192 символа его журнала, полный журнал остаётся в каталоге candidate.

Между snapshot и этой проверкой последовательно запускаются существующие helpers общего
прогона: `deepseekBinary.mts --prepare-suite` готовит A/B и admitted варианты,
`deepseekRuntimeArtifact.mts` — прежнюю generation и её отдельный native prefix.
Оба шага проходят сторож RSS 4096 МиБ. Это исключает холодную установку legacy dependencies
одновременно со сборкой вариантов внутри параллельных тестов; рабочая поставка не меняется.

Серверный набор запускает два файла одновременно с общим RSS-бюджетом 4096 МиБ:
обычный runner имеет два CPU, а native ELF-процессы и их проверки нагружают те же ядра.
Web-набор использует тот же профиль двух файлов и общего RSS-бюджета 4096 МиБ;
Chromium-потомки учитываются сторожем вместе с Node workers.

Серверные тесты получают `NODE_OPTIONS=--test-reporter=tap`: ошибка и её стек появляются
сразу после провалившегося случая, без ожидания итоговой сводки большого набора.
Перед ними workflow печатает свободное место, память и число CPU runner; это позволяет
сопоставить native-пробы с ограничениями CI, не публикуя окружение или секреты.

Workflow разделён на шесть узлов: `plan` → `server`/`web` → `build` → `verify` → `publish`.
Комплект собирается в существующем observed-режиме: stdout/stderr дочерних сборщиков
поступают прямо в Actions, события этапов из fd 3 перенаправляются туда же. Поэтому
ошибка AppImage не теряет свой stdout, а сервер, CLI и окно видны в журнале по отдельности.
`desktop ci --ignore-scripts` исключает postinstall-загрузку Electron; esbuild install
выполняется отдельно. Старый флаг ELECTRON_SKIP_BINARY_DOWNLOAD этой версией не читается.
Web-job готовит те же зависимости без runtime: его набор не запускает Electron.
Отдельный ранний шаг получает runtime
версии из закреплённой зависимости desktop и SHASUMS256 через официальный GitHub API,
проверяет архив также по checksums.json закреплённого npm-пакета и готовит штатный
dist/path.txt. Явный `electronDist` исключает
повторную загрузку runtime и checksum в изолированном HOME упаковщика.
До дорогой сборки runner получает `appimage-12.0.1.7z` через официальный GitHub API,
сверяет закреплённый SHA256 из toolset текущего electron-builder и распаковывает его 7z.
Загрузка имеет максимум три попытки. Только путь проверенных инструментов передаётся
оконному builder через `GRIGDESK_APPIMAGE_TOOLS_PATH` → `APPIMAGE_TOOLS_PATH`; GH_TOKEN
остаётся в подготовительном шаге. Остальные builders сохраняют закрытое окружение.
План проверяет identity, происхождение stable-коммита из main и решение о тестах до дорогих
подготовок. Stable запускается прямо из main либо соответствующего тега vVERSION. Каждый checkout
закреплён на github.sha ручного запуска, поэтому новые коммиты ветки между jobs не
меняют исходники сборки. Тег можно закрепить на успешно собранном коммите позже.
Dev остаётся отдельным пробным каналом. Полная история нужна только плану для ancestry main.

При ручном запуске владелец выбирает `test_mode`: `full` по умолчанию или `skip` с непустой
`skip_reason`. Номер версии и канал не выбирают режим автоматически и не запрещают
ручной пропуск, в том числе для 0.1.1. Решение передаётся строгим `release-checks.json`.
Skip несовместим с validation_run: подтверждение прежнего полного набора является
отдельным режимом, а не отсутствием проверки. Причина skip входит также в оба текста
подписанного описания и testValidation файла release-acceptance.json.

В full server/shared/руководство и web выполняются параллельно. Три серверных набора
имеют continue-on-error для сбора результатов; итоговые ворота требуют outcome success
каждого. Web не имеет continue-on-error. Сборка требует успех обоих jobs в full либо
фактический skipped обоих jobs при согласованном skip или подтверждённом reuse.
Провал или отмена уже запущенного теста не маскируются решением о пропуске.

Build выполняет production UI, свежие бинарники, их verify/E0, подпись и deb. Установщик
встраивает подписанный индекс, поэтому сборка с подписью остаются одним узлом.
SSH-ключа сайта в нём нет. Verify скачивает точный artifact-id этого build, проверяет
подписи, размеры, SHA и описи архивов, identity, deb и реальные server/DeepSeek --verify
в отдельном HOME. Эта проверка обязательна и при skip. Ручная GUI-приёмка сюда не входит.

Publish получает только прошедший verify артефакт и только SSH-ключи сайта, затем повторяет
штатный preflight публикатора. Сбой публикации позволяет повторить failed job с уже
сохранённым artifact-id без повторной сборки. Actions закреплены по SHA; upload v7 и
скачивание v8 используют Node 24. Транспортирует файлы Actions, а не тестовые executable.

Серверный job ограничен 240 минутами, web — 90, сборка — 120, проверка пакетов и публикация —
по 20. Native-пробы на двух CPU могут занимать больше 110 минут. Все ранние ворота выполняются
до ключа подписи; ключ сайта появляется только в publish после успеха verify.
Контракт зависимостей — [GitHub jobs.needs](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds).

До native-подготовки server и build освобождают неиспользуемые этой поставкой
предустановленные .NET SDK, GHC/GHCup и CodeQL. Очистка разрешена только при
`RUNNER_ENVIRONMENT=github-hosted` и ограничена четырьмя явными каталогами.
Node, Python, Android SDK, Rust и браузеры остаются доступными проверкам.
После прогрева вариантов перед серверным набором требуется не менее 16 GiB свободного
места. Низкий остаток останавливает запуск до длительных тестов: source-sync и standalone
builder создают отдельные копии native dependencies и могут исчерпать несколько GiB.
Состав исходного образа — [Ubuntu 24.04 runner image](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md).

Для stable доступно явное [подтверждение успешного полного прогона тех же исходников](release-validation-reuse.md)
через `validation_run`. До ключей проверяются metadata запуска, все outcome-ворота и полные
Git-деревья. Свежие production UI, бинарники, verify/E0, подпись и deb выполняются всегда.

Проверочные варианты ELF и legacy cache принадлежат только серверному runner.
Перед упаковкой свежий runner удаляет собственный подготовительный cache
`$RUNNER_TEMP/deepseek-tests`, предварительно сверяя точное значение пути.
Сборщики поставки используют отдельную изолированную среду; тестовые executable между
job не передаются. Свободное место остаётся для архивов и installer.

Порты основного SSH-сайта и зеркала передаются из `RELEASE_SITE_PORT` и
`RELEASE_SITE_MIRROR_PORT`. При отсутствии секрета workflow подставляет строку `22`:
пустое значение окружения не должно перекрывать стандартный порт публикатора.

Сборщик получает `GRIGDESK_RELEASE_ORIGIN` из того же `RELEASE_SITE_PUBLIC_ORIGIN`,
который использует публикатор; без секрета проверочная сборка берёт публичный origin
по умолчанию. Так подписанные URL архивов совпадают с адресом публикации до подписи,
в том числе при размещении архива на отдельном хосте.

После `server ci` workflow вызывает установленный в проекте CLI `playwright-core install
--with-deps chromium`. Это готовит точную ревизию Chromium, headless shell, ffmpeg и системные
зависимости до серверных recording- и web browser-проверок. Наличие системного Chrome на
runner не заменяет подготовку ревизии проекта. Контракт — [Playwright CI](https://playwright.dev/docs/ci-intro).

Перед отправкой изменения проверь конфигурацию валидатором
[actionlint](https://github.com/rhysd/actionlint):

```sh
actionlint .github/workflows/grigdesk-release.yml
```

Проверки workflow в `tests/server/release-workflow.test.js` и
`tests/relay/release-workflow.test.js` проверяют ручной запуск без `push` и состав выпуска; они не заменяют
валидацию доступности контекстов GitHub Actions. Уведомления настраиваются отдельно
в [GitHub Actions notifications](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications).

Отдельный профиль AppArmor получает `/usr/bin/unshare`: проверка ENOSPC создаёт собственные
user, mount и network namespaces. До тестов выполняется `unshare -Urnm /usr/bin/true`.
После установки Playwright профили создаются для найденных исполняемых файлов Chromium
и headless shell, затем оба режима действительно запускаются с `chromiumSandbox: true`.
Отключение песочницы не заменяет эту пробу.

Для воспроизводимой генерации raster-значков нужен `python3-pil`; его импорт проверяется
до web-набора вместе с системными инструментами.

Внутри серверного набора сторож выполняет source-sync отдельно от остальных файлов;
это полная проверка, а не пропуск после metadata-пробы. Бюджет compiled status MCP составляет
180 секунд на настоящий route loop при общем сроке случая 190 секунд: на двух CPU
он уже занимает около минуты без параллельной сборки.
