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
и закреплённые версии всех трёх Actions, включая загрузку артефактов, проверяются контрактными тестами.

`mobile ci` выполняется до серверных тестов: общая программа TypeScript включает
`tools/mobile-phone`, который импортирует Vite, Vue-плагин и Playwright из зависимостей
мобильного клиента. На чистом runner отсутствие этого шага даёт TS2307 ещё до тестов.

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

Серверные тесты получают `NODE_OPTIONS=--test-reporter=tap`: ошибка и её стек появляются
сразу после провалившегося случая, без ожидания итоговой сводки большого набора.
Перед ними workflow печатает свободное место, память и число CPU runner; это позволяет
сопоставить native-пробы с ограничениями CI, не публикуя окружение или секреты.

После всех тестов и production-сборки UI workflow удаляет только свой каталог тестовых
артефактов `$RUNNER_TEMP/deepseek-tests`, предварительно сверяя точное значение пути.
Проверенные варианты ELF и legacy cache больше не нужны; сборщики поставки используют
собственную изолированную среду. Освободившееся место доступно для архивов и installer.

Порты основного SSH-сайта и зеркала передаются из `RELEASE_SITE_PORT` и
`RELEASE_SITE_MIRROR_PORT`. При отсутствии секрета workflow подставляет строку `22`:
пустое значение окружения не должно перекрывать стандартный порт публикатора.

Сборщик получает `GRIGDESK_RELEASE_ORIGIN` из того же `RELEASE_SITE_PUBLIC_ORIGIN`,
который использует публикатор; без секрета проверочная сборка берёт публичный origin
по умолчанию. Так подписанные URL архивов совпадают с адресом публикации до подписи,
в том числе при размещении архива на отдельном хосте.

Перед отправкой изменения проверь конфигурацию валидатором
[actionlint](https://github.com/rhysd/actionlint):

```sh
actionlint .github/workflows/grigdesk-release.yml
```

Проверки workflow в `tests/server/release-workflow.test.js` и
`tests/relay/release-workflow.test.js` проверяют ручной запуск без `push` и состав выпуска; они не заменяют
валидацию доступности контекстов GitHub Actions. Уведомления настраиваются отдельно
в [GitHub Actions notifications](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications).
