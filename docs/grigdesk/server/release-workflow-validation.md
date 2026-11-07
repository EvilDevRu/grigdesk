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
прежней папки `b24/` в checkout нет. Порядок установки server/web/tracker/relay/deepseek/desktop
и закреплённые версии всех трёх Actions, включая загрузку артефактов, проверяются контрактными тестами.

Перед отправкой изменения проверь конфигурацию валидатором
[actionlint](https://github.com/rhysd/actionlint):

```sh
actionlint .github/workflows/grigdesk-release.yml
```

Проверки workflow в `tests/server/release-workflow.test.js` и
`tests/relay/release-workflow.test.js` проверяют ручной запуск без `push` и состав выпуска; они не заменяют
валидацию доступности контекстов GitHub Actions. Уведомления настраиваются отдельно
в [GitHub Actions notifications](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications).
