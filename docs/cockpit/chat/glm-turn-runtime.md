# Ход GLM: порядок, исходы и повторы

Ход GLM идёт общим web-ходом DSH (`runDeepSeekServerTurn`) с вариантом исполнителя: свои
подписи, классификация ошибки модели, обратное чтение выбора модели и автоодобрение. Без
варианта ход DeepSeek прежний: автоодобрение `cockpit-work` по префиксу, ввод в активный ход.

## Порядок

```text
предполётная проверка → generation и identity допуска → home, overlay, окружение → web
  → session/create или resume → onSessionCreated (CAS привязки) → session/selectModel
    (модель и reasoningEffort одним вызовом) → follow и $events, snapshot follow сверяет
    projections.modelSelection.next → prompt → turn/end → остановка процесса
```

После каждого ожидания до prompt проверяется abort: остановленный ход до модели не доходит,
процесс и каталог запуска закрываются. Предполётная проверка идёт до любого процесса:

- нужен `chatKey` и `onSessionCreated`; Factory, `workspaceAccess`, `untrustedInput`,
  `scopedWorkspace` — `glm_consumer_unsupported`;
- режим чата: пустой — «Правки в проекте», `auto` — «Авто»; `plan`, `bypass`, «Только чтение»
  и неизвестное — `glm_mode_unsupported`;
- модель — пара `["zai","<модель>"]` из каталога; иначе `glm_model_mismatch`; effort без выбора —
  `high` (иначе pi-ai молча выключил бы рассуждение), неподдерживаемый — `glm_effort_mismatch`;
- identity закреплённой generation должна совпасть с записью допуска режима, иначе
  `glm_runtime_not_admitted`.

## Исходы

| Исход | Результат |
| --- | --- |
| Отказ CAS привязки чата | ошибка чата как есть, prompt не отправлен |
| Сбой запуска или RPC до prompt | `glm_runtime_start_failed`, без `emptyRun` |
| Обратное чтение модели или effort не совпало (или DSH отверг выбор) | `glm_model_mismatch` / `glm_effort_mismatch` до prompt |
| Prompt отправлен, ack или поток потерян без `turn/end` | `glm_ambiguous_outcome` с `sessionId` и steps, повтора нет |
| `turn/end` с `code: AUTH` / `QUOTA` | `glm_auth_failed` / `glm_quota_exhausted` |
| `turn/end` с другой ошибкой (`RATE_LIMIT`, `TRANSPORT`, 5xx) | `deliveryFailure` — повтор только кнопкой человека |
| DSH заблокировал ход (например, hook отклонил prompt) | `glm_turn_blocked`, эффекта нет |
| Вызов инструмента без маркера hooks или дескриптора | cancel и `glm_policy_hook_missing` |
| Стоп | `stopped: true` с `sessionId` и steps |
| Без текста и без шагов инструментов | `emptyRun` с `retryState: post_prompt` |
| Без текста, но с шагами инструментов | успех с пустым `reply`, привязка сохраняется |

GLM не вызывает `onInTurnReady` и `onInTurnAvailability`: ввода в активный ход нет. Вопрос
агента (`user-questions/request`) доходит до `onPermission` с `isQuestion`.

## Повторы и сжатие

Повторов нет ни на одном слое: 401, 429 и обрыв потока дают ровно один модельный запрос.
Переполнение контекста — единственный случай повторного запроса: DSH делает запрос-выжимку
прежней истории и повторяет запрос хода с ней. В первом ходе сжимать нечего — после
запроса-выжимки ход завершается сбоем доставки без повтора.

## Размышления и replay

Размышления идут шагом `think` общего нормализатора, в `reply` не попадают. Следующий запрос
той же модели получает `reasoning_content` прежнего ответа, в том числе после resume. После смены
модели прежнее размышление уходит в обычный текст ассистента, а не в `reasoning_content`.
Сообщения прошлых ходов при resume не публикуются как новый ответ.
