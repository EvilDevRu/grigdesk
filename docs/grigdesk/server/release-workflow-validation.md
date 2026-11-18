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
значков. Полный серверный рецепт устанавливает закреплённый
`@qwen-code/qwen-code@0.27.3` из `tests/fixtures/qwen-cli/package-lock.json` и передаёт
его путь через `GRIGDESK_QWEN_BIN`. Native-фикстуры используют loopback API и синтетические
ключи. Разрешение npm на скрипты действует только для закреплённой версии
[проверенного audio-capture hook](../chat/qwen-install-hooks.md).

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
создаёт свежие компоненты, маленький shell installer, helper.gz, индекс v2 и сетевой deb.
Свидетельство решения и receipts входят в артефакт.

Verify скачивает точный artifact id build, проверяет подписи, SHA, описи, identity, deb,
реальные server/DeepSeek пробы и установку local/remote/server в приватных HOME/XDG.
Установка запускается без GUI; desktop release probe работает под xvfb.
Системный Node/npm в PATH установки не требуется. Это не приёмка настоящего окна.

Publish получает только SSH-ключи после успешного verify и повторяет preflight publisher.
Он переносит те же байты без сборки и подписи. Повтор публикации использует сохранённый
artifact id. Порты берутся из секретов, пустое значение заменяется на 22.
Origin сборщика и publisher согласован через RELEASE_SITE_PUBLIC_ORIGIN.
Локальные кандидаты с тестовым ключом не публикуются.

## Продвижение кандидата

`grigdesk-promote.yml` принимает source_run_id, artifact_id, channel, version, commit и digest.
GitHub API подтверждает успешный release-workflow того же репозитория и принадлежность artifact
запуску. Скачивание идёт по id; verify повторяется перед SSH. Новая сборка, смена канала,
переподпись и переименование dev в release не допускаются. Publish по умолчанию выключен.

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
