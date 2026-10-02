# GLM: основания для интеграции и непроверенные границы

Сверено 01.10.2026 по текущему дереву Cockpit, официальной документации Z.ai и OpenCode,
а также отдельным исходникам OpenCode `v1.18.34`. Это исследование для
[плана TDD](glm-integration-tdd-plan.md), а не отчёт о работающей интеграции.
Бинарь OpenCode и запросы к модели при подготовке документа не запускались.
Дополнено при [независимом ревью плана](glm-plan-review.md); это также проверка исходников,
а не допуск runtime.

## Что уже предоставляет Cockpit

- `server/src/lib/executors/index.ts` автоматически загружает адаптеры из соседних файлов.
  Карточка без `run()` остаётся установочной и не попадает в реестр исполнителей чата.
- `server/src/lib/acp/client.ts` реализует NDJSON JSON-RPC, очередь уведомлений и независимую
  обработку обратных запросов. `initializeAcp()` передаёт protocol version `1` и не обещает
  клиентские файловые операции. Совместимость нового агента требуется проверить отдельно.
- `server/src/modules/chat/index.ts` выдаёт исполнителю `onPermission`, `onStep`, `onProgress`,
  `onSessionCreated`, `onRunMetadata`, `signal` и рабочие MCP. Добавлять ветку `glm` не нужно.
- `sessionBinding` включает серверное владение сессией и CAS. `PRE_PROMPT_ONLY` ограничивает
  автоматический повтор; отсутствие этого объявления включает старое поведение повторов.
- `modelsRegistry.ts` сохраняет каталог, обновляет его через `catalogLive` и учитывает
  `catalogCacheKey`. Временная недоступность исполнителя не должна удалять выбор модели.
- `workTools` содержит надзорные SSH/БД. Общего встроенного цикла API → файловые инструменты
  → shell в Cockpit нет: нынешние исполнители используют агентные runtime.
- DeepSeek сейчас запускает web-транспорт. Его ACP-код полезен как пример протокола,
  но копирование адаптера целиком перенесёт чужие API, права и модельные идентификаторы.

## Z.ai: модельный API и подписка — разные подключения

Обычный API использует базовый адрес `https://api.z.ai/api/paas/v4` и ключ в заголовке
Bearer. Для Coding Plan документированы отдельные адреса; для Chat Completions это
`https://api.z.ai/api/coding/paas/v4`. Переключать адрес при отказе автоматически нельзя:
это меняет выбранный способ доступа. Источники:
[HTTP API](https://docs.z.ai/guides/develop/http/introduction),
[подключение инструментов](https://docs.z.ai/devpack/tool/others).

OpenCode присутствует в списке поддерживаемых Coding Plan инструментов. При этом документация
ограничивает подписку перечисленными сценариями: наличие совместимого HTTP-протокола само по
себе не доказывает поддержку произвольного собственного клиента. В плане основной вариант —
обычный API; подписка остаётся явно выбранной конфигурацией OpenCode.
[Правила использования](https://docs.z.ai/devpack/usage-policy).

В полученном [OpenAPI Z.ai](https://docs.z.ai/openapi.json) есть
`components.schemas.ChatCompletionTextRequest.properties.model.enum`, но нет операции
`GET /models`. Это факт о проверенной схеме, а не доказательство отсутствия такого endpoint
во всех сервисах Z.ai. Нельзя поручать исполнителю выдумать discovery endpoint по аналогии
с другим API. В выбранном решении источник моделей — живой каталог агентного runtime.

Поля thinking и допустимые усилия зависят от модели. Совместимость Chat Completions не даёт
оснований копировать лестницу DeepSeek или считать `off` универсальным значением.
Для interleaved thinking провайдер требует сохранять reasoning-блоки между вызовами
инструментов; эту часть модельного протокола в выбранном решении обслуживает OpenCode.
[Thinking Mode](https://docs.z.ai/guides/capabilities/thinking-mode).

## Почему в плане выбран OpenCode

`opencode acp` предоставляет JSON-RPC по stdio и агентные функции: работу с файлами,
терминалом и MCP. Это позволяет использовать ACP-клиент Cockpit, не создавать собственный
цикл выполнения инструментов. Это проектное решение на основании
[официального контракта ACP](https://opencode.ai/docs/acp/).

У OpenCode документированы отдельные подключения Z.AI и Z.AI Coding Plan.
`opencode models [provider]` выводит идентификаторы; `--refresh` обновляет каталог,
`--verbose` добавляет metadata. Каталог runtime не является проверкой оплаты или доступа
конкретного аккаунта к каждой модели.
[Провайдеры](https://opencode.ai/docs/providers/#zai),
[команда models](https://opencode.ai/docs/cli/#models).

Кандидат для первого contract spike —
[OpenCode v1.18.34](https://github.com/anomalyco/opencode/releases/tag/v1.18.34).
Обнаружение релиза не означает его допуска к runtime Cockpit. Версию и integrity установочного
артефакта нужно закрепить только после проверки; автоматического обновления в плане нет.

## Что показало чтение точного тега

1. [Команда acp](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/cli/cmd/acp.ts)
   вызывает `Server.listen(opts)`. Значит, stdio-транспорт также открывает HTTP listener.
   Нужно проверить loopback, случайный порт, авторизацию и отсутствие mDNS.
2. [Config options](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/acp/config-option.ts)
   объявляют `model`, `effort` и `mode`; список effort строится для текущей модели.
   Специальное значение `default` обозначает выбор runtime. Его нельзя показывать как отдельную
   модель или механически подменять значением `off`.
3. [Обработчик разрешений](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/acp/permission.ts)
   использует варианты `allow_once`, `allow_always`, `reject_once`; ошибка обратного запроса
   приводит к отказу. Адаптер Cockpit должен выбирать вариант по `kind`, а не по подписи.
4. [Команда models](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/cli/cmd/models.ts)
   в verbose-режиме пишет строку `provider/model`, затем форматированный JSON модели.
   Весь stdout не является одним JSON-документом. Refresh также печатает служебную строку.
5. [Загрузка config](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/config/config.ts)
   объединяет несколько источников и обнаруживает плагины отдельно. Найдена проверка
   `OPENCODE_DISABLE_PROJECT_CONFIG`, но одного прочитанного условия недостаточно, чтобы
   утверждать изоляцию `.opencode`, skills, MCP и `.env`. Нужен source audit зависимых загрузчиков
   и тест с файлами-маркерами. Правила объединения описаны и в
   [документации конфигурации](https://opencode.ai/docs/config/).
6. В [ACP service](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/acp/service.ts)
   `selectModelVariant` и `restoreVariant` сохраняют прежний variant. Убрать effort из входа
   Cockpit недостаточно: требуется явный сброс и проверка результата.
7. Там же `registerMcpServers` подавляет ошибки регистрации через `Effect.ignore`.
   Успех new/resume не подтверждает готовность MCP; способ её наблюдения — обязательный S01 gate.
8. `usage_update.cost` там вычисляется через `totalSessionCost(messages)`.
   Накопительную стоимость нельзя записывать как расход отдельного хода.

## Что остаётся доказать реализацией

- Установочный пакет, его integrity, точные upstream provider IDs и источник ключа.
- Полный lifecycle ACP: new, set model/effort, prompt, permission, cancel и resume другим процессом.
- Готовность обязательного MCP до prompt и явный сброс прежнего effort на resume.
- Поведение pending tool calls после cancel/crash и отсутствие автоматического повторного действия.
- Приоритет серверной конфигурации, отключение посторонних источников и всех вспомогательных
  моделей, которые могли бы обратиться к другому провайдеру.
- Реальное применение запрета SSH/БД и невозможность обхода через нативный shell/subagent.
- Отсутствие автоматического наследования служебных секретов shell/MCP-процессами и случайной
  публикации в tool output; это не изоляция от произвольного same-uid кода.
- Загрузка инструкций проекта с импортами, передача MCP и работа обычного пользовательского хода.
- Формы usage/context, фактическая модель ответа и работа stop во время вопроса.

До этих проверок нельзя объявлять sandbox, `scopedWorkspace`, обработку недоверенных входящих,
живые уточнения, постоянную сессию процесса или полную совместимость возможностей.
Обычный host-процесс с запросами разрешений не является изоляцией ОС.
