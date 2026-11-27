# Общий релизный рецепт и workflow

`.github/workflows/grigdesk-release.yml` запускается вручную и сохраняет граф
`plan → server/web → build → verify → publish`. Full — умолчание; skip требует причины,
reuse — подтверждённого успешного полного запуска тех же исходников.
Failed/cancelled job не становится skipped. [Правила выбора](release-test-selection.md).

## Один исполняемый набор

Команды принадлежат `tools/releaseRecipe.json`, lifecycle — `tools/releasePipeline.mts`.
Server вызывает группы prepare-server,prepare-build,server; web — prepare-web,prepare-build,web;
build — build. Локальный `grigdesk-ctl dist build` выполняет тот же рецепт последовательно
в отдельных снимках. Обычный быстрый `build` этого полного прогона не делает.

Рецепт включает server, shared, guide, voice, routes, web и профильные installer/dist проверки.
Native warmup и проверка cache-root идут до серверных тестов. Node-тесты проходят через
сторож памяти с RSS 4096 MiB и concurrency 2; код выхода является воротами.
Независимые проверки заканчиваются после отказа соседней, упаковка блокируется.
SIGINT/SIGTERM фиксируют 130/143, timeout — 124; завершение child с 0 этого не отменяет.
Общий helper проверяет PID/starttime, дожидается TERM, затем KILL и подтверждения завершения.
Runner выполняет один обход дерева процессов за раз. Список сохраняет живых потомков
и исходную идентичность корня, чтобы история завершённых PID не увеличивала время отмены.
Чужие процессы не сигналятся.

Darwin-ветка runner получает проверенные инструменты и версии toolchain до начала
стадий. Она начинает проверку очистки после непосредственного выхода ребёнка,
отмены или таймаута. При неизвестном владельце дальнейший запуск блокируется.
Выбор macOS запускает отдельные стадии подготовки и проверки на Apple Silicon.
Нативный прогон готового комплекта указан отдельно.
[Остановка и подтверждение владения на Darwin](darwin-process-identity.md).

Каждый запуск сохраняет отдельный журнал и pipeline receipt. При failure Actions выгружает
их через always. RecipeDigest покрывает canonical recipe, runner, environment, provisioning
и общий код управления процессами. Full verify требует успешных исходов всех обязательных
server/web стадий с этим digest: одного receipt сборки недостаточно.

## Подготовка

Версия Node читается из `server/build/node-runtime.json`; локально проверяется SHA того же
архива и извлекаются собственные Node/npm. Установка зависимостей и прогревы заданы рецептом.
Desktop использует ci --ignore-scripts и отдельную установку esbuild. Общий
`tools/ci/prepare-release-desktop.sh` готовит Electron и инструменты AppImage перед упаковкой
в CI и локально. Архивы проверяются по закреплённым SHA-256 до распаковки. Actions использует
токен GitHub только для загрузки, а локальный рецепт использует публичный HTTPS.
Doctor проверяет наличие curl, unzip и 7z.

`tools/ci/provision-ubuntu.sh --disposable-environment` готовит одноразовую Ubuntu 24.04:
пакеты, Playwright Chromium и его sandbox, AppArmor для bubblewrap/unshare, реальные пробы,
xvfb и FUSE для проверки готового окна. Ни doctor, ни dist build не вызывают sudo.
Отключение Chromium sandbox не считается успешной пробой.

Подготовка проверяет ffmpeg, ffprobe, ripgrep и импорт Pillow для генерации растровых
значков. Полный серверный рецепт подготавливает Linux ELF Qwen Code 1.0 Preview.2 через
`tools/install-qwen-preview.sh` и передаёт его путь как `GRIGDESK_QWEN_BIN`.
Скрипт проверяет закреплённый SHA-256 до распаковки и входит в RecipeDigest.
Проверки Preview.2 используют loopback API с синтетическим ключом и включаются
через `GRIGDESK_QWEN_PREVIEW_TEST=1`. [Контракт рантайма](../chat/qwen-preview-runtime.md).

Общий launcher серверных тестов создаёт собственный `app-grigdesk-tests-*.scope`
у уже работающего пользовательского systemd, задаёт Bash и передаёт адрес его шины
в фикстуру Qwen. Это даёт Qwen Host отдельного владельца для `BindsTo`.
Локальные install acceptance и stages вне server-tests сохраняют приватное окружение.
На одноразовом GitHub runner `MemoryMax=4G` на пользовательском менеджере ограничивает суммарную память
набора и дочерних Qwen scope, в том числе за пределами process group сторожа.
Сторож запускает DeepSeek source-sync отдельно. Срок compiled status MCP для настоящего
route loop составляет 180 секунд при общем сроке случая 190 секунд.

Удаление .NET/GHC/CodeQL остаётся отдельным github-hosted шагом с явным guard;
на рабочую ОС оно не переносится. Перед native-набором нужно 16 GiB свободного места.
Doctor проверяет инструменты, sandbox, браузер, место и ограничения фактического хоста.
Для серверного рецепта доступность пользовательского systemd проверяется до нативных тестов.
Произвольная локальная ОС не объявляется эквивалентной облачному runner.

## Доверие по jobs

Checkout закреплён на github.sha. Plan проверяет identity, происхождение main и full/skip/reuse
до ключей. Server/web не получают релизных полномочий. Build получает только ключ подписи,
создаёт свежие компоненты, маленький shell installer, helper.gz и индекс формата 3.
В stable build Linux x64 добавляет офлайн-.deb и ZIP, в dev собирает сетевой .deb.
Свидетельство решения и receipts входят в артефакт.

Verify скачивает точный artifact ID build и проверяет подписи, SHA, описи, identity,
поля .deb и побайтное совпадение встроенных файлов stable ZIP и .deb с сырым комплектом.
`verified-proof.json` содержит SHA и размеры трёх публичных файлов Linux x64 для release
и пустой `publicAssets` для dev. Proof выгружается отдельно с ID в `proof_artifact_id`.
Затем выполняются реальные server/DeepSeek пробы и установка local/remote/server в приватных HOME/XDG.
Установка запускается без GUI; desktop release probe работает под xvfb.
Системный Node/npm в PATH установки не требуется. Это не приёмка настоящего окна.

Прямой publish из release workflow доступен для dev. Для нового stable
регламент требует общий promote с отдельным proof. Publish получает SSH-ключ
после успешных проверок и повторяет preflight publisher.
Он переносит те же байты без сборки и подписи. Повтор публикации использует сохранённый
artifact id. Порты берутся из секретов, пустое значение заменяется на 22.
Origin сборщика и publisher согласован через RELEASE_SITE_PUBLIC_ORIGIN.
Локальные кандидаты с тестовым ключом не публикуются.

## Выбор платформ

В форме **Run workflow** включены два флажка, **Linux x64** (`linux`) и
**macOS Apple Silicon** (`macos`). По умолчанию выбран канал `dev`.
С одним флажком workflow собирает и проверяет комплект этой платформы.
Без выбранных платформ план завершается ошибкой до сборки.
Для одного Linux доступны проверочные сборки release и dev. Прямая публикация допускается для dev.

В прежнем маршруте кандидатов для macOS нужны `channel=dev`, `publish=false`, `test_mode=full`
и пустые `skip_reason` и `validation_run`. План закрепляет commit и итоговую
версию выбранных комплектов. Соседний номер используется в изолированной
приёмке обновления. Общие Ubuntu-проверки server/web выполняются по одному разу.
Apple Silicon использует `macos-15`, свой Node pin и формулы из `tools/ci/Brewfile.macos`.

В GitHub Environment `platform-candidate` хранится ключ Ed25519
`CANDIDATE_SIGNING_KEY` и его публичный canonical SPKI PEM в Base64
`CANDIDATE_PUBLIC_KEY_B64`. Закрытый ключ передаётся только шагу
подписи уже подготовленных файлов. Отдельные verify jobs скачивают
свои артефакты по ID. Последняя стадия перепроверяет описи, подписи
и обязательную приёмку всех выбранных платформ до выгрузки.
В summary попадают ID и SHA-256 выданных установщиков.

## Общий стабильный комплект в Actions

Полный маршрут выбирает все шесть флажков `linux`, `macos`, `linux-arm64`,
`windows-x64`, `windows-arm64` и `android` с `channel=release`,
`test_mode=full`, `publish=false`. Android даёт обе ABI. Для полного маршрута
нужна первая попытка запуска. `stable-plan.json` закрепляет одну версию, SHA
исходников и ID запуска. Проверки server/web и классический Linux x64 build
используют идентичность стабильного выпуска.

Стабильные macOS, Linux ARM64, обе Windows и обе ABI Android проходят через
`grigdesk-stable-native.yml`. Каждый вызов выделяет отдельные jobs сборки и проверки
на целевом runner. Проверяющий job получает точно тот artifact ID, который
вернул сборщик, и подтверждает собственную выдачу. Джоб `stable_assets` требует
успех всех проверок и сверяет хеш плана, артефакты по ID, описи и байты файлов.
Затем появляются `grigdesk-stable-downloads-<run>-1` с девятью файлами и отдельный
`grigdesk-stable-proof-<run>-1` с их размерами и SHA-256.

### Контракт нативных сборщиков

Нативная реализация предоставляет два входа в `tools/ci/`:

- `buildStableNative.mts <target> <plan.json> <build-dir>` собирает и подписывает
  исходную поставку по плану. `RELEASE_SIGNING_KEY` доступен только на этом шаге.
- `verifyStableNative.mts <target> <plan.json> <build-dir> <verified-dir>`
  проверяет подписи, identity, платформу и штатную установку. Для Android проверяет
  отдельный production APK signer и каждую ABI. Verify получает открытые данные.

Оба входа читают план через `readStableReleasePlan` с `GITHUB_SHA`,
`GITHUB_RUN_ID` и `STABLE_PLAN_SHA256`. В корне `verified-dir` лежат
`stable-native-proof.json` и одна папка на подтверждённую платформу.
Группа `android` содержит `android-arm64` и `android-x86_64`. Proof имеет
`format: 1` и массив `parts` в том же порядке. Каждая часть содержит
`platform`, `channel`, `version`, `commit`, `releaseId`, `runId`,
`planDigest`, `manifestDigest`, `signerFingerprint` (SHA-256 публичного Ed25519
SPKI DER) и `files` с полями `name`, `size`, `sha256`.

Linux ARM64 и macOS передают восемь файлов из `offlinePackageFiles('release')`.
Windows передаёт `grigdesk-install.ps1` с `.sha256` и `.sig`,
`grigdesk-maintenance.exe`, `release.json`, `desktop.exe` и `server.zip`.
Папка каждой Android ABI содержит `grigdesk.apk`. Финальный job архивирует
проверенные файлы и переименовывает APK для общей выдачи.

Нативные входы Windows собирают NSIS для окна, архив сервера со своим Node
и Go-фабрикой, PowerShell bootstrap и Go-помощник. Проверяющий job сверяет
подписи и байты, устанавливает из локального источника с пробелами в путях
и проверяет архитектуру установленных Node, фабрики и Electron. Затем он
открывает установленный GrigDesk, дожидается локальной сессии и рабочей области,
закрывает окно и проверяет остановку сервера. Деинсталляция проверяет удаление
исполняемых файлов и сохранение отдельной папки данных.
[Контракт Windows-комплекта](windows-offline-installation.md).

Остальные нативные цели с отсутствующими адаптерами завершаются с
`stable_native_adapter_missing`. Локальные тесты проверяют маршрутизацию
и сбор комплекта по фикстурам. Реальные установки проходят на целевых системах.

## Продвижение кандидата

`grigdesk-promote.yml` принимает source_run_id, artifact_id, channel, version, commit и digest.
GitHub API подтверждает успешный release-workflow того же репозитория и принадлежность artifact
запуску. Скачивание идёт по ID, затем verify повторяется до SSH. Пакеты сохраняют
исходные канал и подпись. Publish по умолчанию выключен.

Stable publish с точного checkout из актуального `main` требует `stable_proof_id`.
CLI проверяет отдельный артефакт `grigdesk-stable-proof-<run_id>-1`, успешный job
общей подготовки, девять записей о файлах и байты Linux из build ID. Второй допуск
публикатора сравнивает proof с подписанным Linux manifest. На историческом checkout
сохраняется inspect. Публикация historical stable из актуального workflow закрыта.

[Порядок выпуска](../../releases.md).

Сайт синхронизируется и публикуется владельцем после выпуска приложения.
Retention хранит две последние лёгкие версии канала, исключая исторические полные комплекты.
[Детали установщика и хранения](lightweight-installer.md).

## Проверка конфигурации

```sh
actionlint .github/workflows/grigdesk-release.yml .github/workflows/grigdesk-promote.yml
```

Профильные workflow/checks/validation тесты проверяют граф, команды, receipts и границы ключей;
процессные тесты runner проверяют настоящие exit/cancel/timeout. Live Actions, платный допуск GLM,
GUI на чистой VM и публикация требуют отдельного поручения владельца.

Проверки workflow в `tests/server/release-workflow.test.js` и
`tests/relay/release-workflow.test.js` проверяют ручной запуск без `push` и состав выпуска; они не заменяют
валидацию доступности контекстов GitHub Actions. Уведомления настраиваются отдельно
в [GitHub Actions notifications](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications).
