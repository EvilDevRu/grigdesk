# Текстовый вызов DeepSeek и GLM без инструментов

DeepSeek и допущенная карточка GLM объявляют `untrustedInput: { text: true, images: false }`
и отдельный `runUntrusted`. Это позволяет текстовым потребителям ядра выбирать их через
существующий resolver каталога: `core.modelText`, триаж недоверенного текста и Showcase.
Обычный `run` не используется как fallback. Наличие capability не заменяет проверку
установки, авторизации, доступности модели и effort. Карточка GLM без разрешённого режима
остаётся setup-only без `runUntrusted`; несовпавшая identity выпуска запрещает запуск.

## Изоляция

`server/src/lib/executors/scopedDsh.ts` владеет общим одноразовым профилем. Отдельные входы
`runScopedDsh` и `runModelOnlyDsh` задают режим внутри модуля: внешнее поле `modelOnly`
не переключает триаж. Его файловые инструменты и ограниченный MCP сохраняются.

Model-only получает новый приватный каталог, home и пустой cwd для каждого вызова.
Внешние cwd, sessionId, workspaceAccess, callbacks шагов и настройки чата не передаются.
Профиль содержит только фиксированный persona preset без runtime context; пользовательские
и поставленные preset roots, agent instructions, session/file references отключены.
MCP не подключается. Native guard запрещает исполнение любого инструмента, запрос с tools,
любые tool-call chunks и второй LLM stream. Одноразовый proof подтверждает регистрацию guard
до создания сессии; snapshot подтверждает provider/model/effort до prompt.

`file-upload` и `session-persistence-jsonl` остаются включены: web session controller требует
сервисы `fileUploads`, `sessionPersistence` и зависимый workspace registry. Это не добавляет
модели файловых инструментов или истории пользователя: вложения запрещены на входе,
сессия всегда новая, журнал хранится только в свежем home и удаляется с ним.
Штатный cleanup сначала останавливает собственный процесс, затем удаляет собственный каталог.
Чужие и неизвестные временные каталоги автоматически не убираются.

## Доступ и результаты

DeepSeek использует только `DEEPSEEK_API_KEY`. GLM сохраняет выбранный режим `api` или
`coding-plan`, соответствующий ключ, маршрут `zai`, default effort `high` и существующий
`assertGlmGenerationAdmission`. Ключ другого режима не подставляется. Новые admission records,
тарифы и изменения compatibility не нужны. Обычный `runGlmTurn` по-прежнему отвергает
чатовый вызов с `untrustedInput`; model-only проходит отдельным закрытым входом.

В новом профиле отключён `llm-retry`, маршруты имеют `maxRetries: 0`. Ошибка, пустой ответ,
незавершённый stream, finish reason `length`/`tool_calls`, отмена или превышение лимита дают
отказ без автоматического повторного запроса. Возвращаются только законченный `reply`,
`sessionId: null`, сообщённый runtime `actualModel` либо `null` и `cost: null`.
Ошибки пересоздаются по разрешённым кодам с фиксированным сообщением, без исходного текста,
cause, sessionId и steps. Квитанцией владеет существующий core API.

Текст запроса и ответа ограничен 131072 символами, поток вместе с размышлениями — 2 МиБ.
Transport принимает целый timeout от 1 до 900000 мс, по умолчанию 300000; публичный
`core.modelText` сохраняет предел 300000, Showcase может передать свои 900000 напрямую.
Общий срок начинается до metadata и подготовки маршрута. Opt-in `interruptOnAbort`
прерывает create/select/ready/prompt и повторную descriptor verification; отмена waiter
не убивает общий metadata probe другого caller и не допускает позднего web spawn.
Обычный чат и scoped triage этот opt-in не включают.

После срока остаётся ограниченный cleanup: binary owner сохраняет TERM 6000 мс и
KILL 2000 мс, затем удаляются собственные файлы. Мгновенный возврат в момент deadline
и гарантированная отмена уже принятого внешним вендором запроса не обещаются.

## Проверка

С установленным проверенным ELF и отдельным тестовым cache:

```bash
NODE_TEST_MAX_RSS_MB=4096 bash tests/run-node-tests-safe.sh --test --test-concurrency=2 \
  tests/server/dsh-model-cancellation.test.mts tests/server/dsh-model-only.test.mts \
  tests/server/deepseek-model-only.test.mts tests/server/glm-model-only.test.mts
NODE_TEST_MAX_RSS_MB=4096 bash tests/run-node-tests-safe.sh --test --test-concurrency=2 \
  '--test-name-pattern=(deepseek|glm|DSH)' tests/server/triage-scoped-runners.test.mts
npm --prefix server run typecheck
```

`GRIGDESK_TEST_DEEPSEEK_BINARY` и `GRIGDESK_TEST_DEEPSEEK_CACHE_DIR` задают тестовую поставку.
Проверки используют настоящий DSH, synthetic ключи, loopback endpoint и запрет внешнего fetch.
Они проверяют изоляцию, выбор обоих режимов GLM, отказ без ключа/admission, квитанции,
отмену удержанных RPC и metadata, пустой/чрезмерный/частичный ответ, ошибки HTTP и обрыв потока,
отсутствие повтора и утечек. Это не доказательство работы живого оплачиваемого API вендора.

После серверных изменений нужен ручной перезапуск GrigDesk и обновление окна. В выборе
исполнителя текстового потребителя проверить доступность при подходящем каталоге/ключе и
отсутствие ложного доступа без ключа. Paid prompt для этой проверки не требуется.
