# Gemini: границы подключения и внешние контракты

Проверено по коду GrigDesk и официальной документации 18 октября 2026 года.
Здесь описаны существующие точки подключения и документированный upstream.
Работоспособность Gemini runtime живым запуском этим документом не подтверждается.

## Чат и конвейер подключаются отдельно

Реестр `server/src/lib/executors/index.ts` обнаруживает адаптеры по файлам `.ts` и `.js`.
Для работы в чате необходим универсальный адаптер с `run`; карточка без этого метода
может предоставлять только настройку. Общий stdio ACP-клиент уже существует в
`server/src/lib/acp/client.ts`.

Factory независимо обнаруживает модули `engine/lib/runners/*.sh`.
Серверный `runnersCatalog.ts` перечисляет эти модули, а не чатовые адаптеры;
наличие файла не проверяет авторизацию или работоспособность CLI.
Подробнее — [границы выбора раннера](../pipeline/runner-selection-boundaries.md).

В `engine/lib/executor.sh` уже есть offline-запрет команд `gemini` и `gemini-*`.
Файл `tests/engine/fakes/bin/gemini` завершает случайный вызов кодом 97.
Обе защиты существуют независимо от наличия рабочего Gemini-раннера.

Shell guard проверяет непосредственно переданный executable и kind. Вызов
`factory_exec local node helper.mts` не запрещает helper-у самостоятельно запускать
CLI. Поэтому отсутствие model prompt в metadata-проверке само по себе не доказывает,
что такая проверка остаётся offline.

## Контракты, которые нельзя считать автоматическими

- `server/src/lib/chat/retryContract.ts` при отсутствии `retryContract` адаптера
  использует `legacy_empty_run_once`. Собственный runtime без retry-loop не исключает
  повтор пустого хода на уровне `server/src/modules/chat/index.ts`.
- `resolveWorkdirCapability` в `server/src/lib/chat/workdir.ts` требует оба поля:
  `switch` и `roots`. Декларация только с `switch: 'reseed'` даёт `null`.
- Обычные вложения передаются в `attachmentPaths` и `attachmentsDir`. Capability
  `inTurnInput.images` описывает уточнения во время хода. В обычном ходе общий route
  добавляет весь каталог вложений в `extraDirs` для исполнителей, кроме Kimi;
  это необходимо учитывать при ограничении доступа точными файлами.
- `engine/lib/multi-runner.sh` подставляет `high` при пустом effort, в том числе
  на границе вызова launcher-а. Отсутствие effort у модели не означает, что раннер
  автоматически получит пустую строку.
  Dispatcher и `profile-preflight.sh` читают `EXACT` из профиля; из stdout функции
  `default_policy` это поле не извлекается.
- `writeRouteSecretsFile` в `server/src/lib/factoryRouteCli.ts` использует общий
  `route-secrets.env`. Такой путь не гарантирует снимок ключей конкретного launch,
  если другой запуск изменит файл до его чтения systemd.
  Ошибка вызова `systemd-run` также не доказывает отсутствие юнита: текущий callback
  возвращает `ok: false` и при timeout ожидания, установленном в 15 секунд.
- `engine/lib/runtime-usage.mjs` извлекает terminal failure только для Codex и GLM;
  `server/src/lib/runnerStall.ts` также ограничивает чтение diagnostics этими раннерами.
  Поддержка нового формата в `readAgentLive` сама по себе не сохраняет причину
  завершившейся попытки в карточке остановки.

Это факты текущей реализации, а не утверждение о наличии перечисленных проблем
в уже работающем Gemini: его runtime пока отсутствует.

## Транспорт и данные провайдера

Официальная документация описывает ACP через stdio JSON-RPC и запуск `gemini --acp`.
Указаны управление сессией, выбор модели, отмена и взаимодействие с MCP.
Точные wire methods, capabilities и порядок событий требуют проверки выбранной
версии CLI. [ACP Mode](https://geminicli.com/docs/cli/acp-mode/).

Headless `stream-json` — отдельный формат JSONL-событий. Его события и статистика
не доказывают наличие тех же данных в ACP.
[Headless mode](https://geminicli.com/docs/cli/headless/).

Gemini документирует вход Google и API key. Поддержка способа входа сама по себе
не подтверждает готовность конкретного аккаунта или доступность модели.
[Authentication](https://geminicli.com/docs/get-started/authentication/).

Политика разрешений инструментов и песочница имеют разные задачи. Поддержка
`allow/deny/ask_user` не доказывает ограничение файловых операций shell.
Для Factory `state-only` требуется фактическая граница записи исходников, как
предписывает `docs/engine/ENGINE.md`.
[Policy engine](https://geminicli.com/docs/reference/policy-engine/),
[Sandboxing](https://geminicli.com/docs/cli/sandbox/).

Процесс добавления раннера, происхождение fixtures, классификацию ошибок и живой
допуск определяет [ADDING-RUNNER](../../engine/ADDING-RUNNER.md).
