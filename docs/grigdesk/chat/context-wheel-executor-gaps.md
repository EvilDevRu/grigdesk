# Кольцо контекста: пробелы исполнителей (DeepSeek/GLM окно, Kimi нативный компакт)

Проверка 29.10.2026 по жалобе «кольцо то фигню показывает, то пустое, сжатие не работает».
Метод: трассировка адаптеров GrigDesk, исходников runtime DSH (пакет generation), бинаря
Kimi 2.4.0 и числовых метрик истории чатов (без чтения переписки). Расчёты не менялись.

Ниже сохранён диагноз на 29.10.2026. Внедрённое поведение описано в разделе
«Текущее состояние»; исторические формулировки не являются описанием текущего адаптера.

## Что работает

| Исполнитель | Замер | Окно | Примечание |
| --- | --- | --- | --- |
| Claude | `active-input-v1`, вход последнего основного обращения | каталог CLI (сам не сообщает, `contextWindow` в истории всегда 0) | Кольцо рисуется; `unavailable` после `compact_boundary` — штатно |
| Codex | `active-input-v1` | сообщает сам (например 258 400/475 000) | Работает |
| Kimi (server-транспорт) | `kimi-agent-status-v1` из `agent.status.updated` | `maxContextTokens` (262 144) | Работает; старый ACP-путь давал `kimi-session-status` |

## Пробел 1: DeepSeek/GLM — окно контекста не приходит никогда, кольцо «недоступно»

Web-ход обоих исполнителей идёт через `server/src/lib/deepseek/serverTurn.ts` → метрика `deepseek-web-usage`
(сумма `inputTokens + cacheReadTokens + cacheWriteTokens` usage-чанка). Окно адаптер читает
из `usage.contextWindow` — но такого поля в протоколе DSH НЕТ: `TokenUsage`
(`packages/llm/llm/src/types.ts`) содержит только токены. Подтверждение историей: у всех
64 чатов DeepSeek и 42 чатов GLM с метрикой `deepseek-web-usage` `contextWindow = 0`;
окно встречается только у старых ACP-замеров `deepseek-acp-usage-update` (ACP-событие
`usage_update` несло `size`).

Окно у DSH ЕСТЬ, но в другом месте: проекция `contextPressure`
(`packages/llm/token-meter/src/projection.ts`) даёт `pressureTokens` (тот же вход),
`projectedTokens` и `contextWindow` («newest recorded route capacity» из события
`request/context`). Она публикуется в snapshot (`projections.values.contextPressure`) и
событиями `projection` — адаптер их не читает.

Следствие в UI: каталог DeepSeek/GLM объявляет модели `contextRuntimeOnly: true` без
паспортного окна, поэтому `ctxRuntimeWindowPending` в `ChatSession.vue` истинно всегда →
`ctxUnavailable` → кольцо постоянно «Точная заполненность пока недоступна», дуга пустая,
хотя измеренные сотни тысяч токенов лежат в истории (замеры до 568k). Это и есть
«у дипсика вообще пустое». До 18–22.10.2026 webRuntime не сообщал и токены
(`contextMetric: unavailable` в старых чатах) — отсюда «раньше вообще пусто».

Граница: `pressureTokens` — вход последнего запроса, `projectedTokens` — оценка
СЛЕДУЮЩЕГО (реагирует на компакцию). GrigDesk считает заполненность входом последнего
запроса — для паритета кольца достаточно `contextWindow` проекции.

## Пробел 2: Kimi — кнопка «Сжать» не сжимает, кольцо показывает прежний размер

Адаптер объявляет `compaction: { kind: 'native', message: '/compact' }` из времён
ACP-транспорта, где слэш-команды исполнял сервер Kimi (`runBuiltinSlashCommand` →
`agent.compact`, без LLM-хода). Но чат Kimi уже ходит через web REST
(`runKimiServerTurn` → `POST /api/v1/sessions/{id}/prompts`), а web-слой Kimi 2.4.0
НЕ интерпретирует слэш-команды: `detectSlashIntent`/`parseSlashInput` вызываются только
из ACP-обработчика `prompt()` и TUI; REST кладёт текст в `IAgentLoopService.submit`
обычным user-сообщением. Отдельного REST-эндпоинта compact в списке маршрутов
`/sessions/{id}…` нет.

Поэтому «/compact» уходит модели как текст: Kimi отвечает что-то от себя, контекст НЕ
сжимается. GrigDesk при этом по своему контракту честно гасит кольцо и пишет
«🗜 Контекст сжат — было N токенов» (`out.contextTokens = 0` в `modules/chat`). Следующий
обычный ход присылает `agent.status.updated` с прежним размером — «после сжатия
показывает то же, что до сжатия», и сжатие действительно не произошло.

Проверка в живой истории: все записи `compactedAt` у Kimi относятся к сентябрю 2026
(ACP-эпоха); в октябре, при web-транспорте, ручных сжатий Kimi не зафиксировано.

## Текущее состояние

DeepSeek/GLM читают окно из `snapshot.projections.values.contextPressure` и
`request/context` DSH. Полное сообщение без допустимой ёмкости сбрасывает окно в 0;
usage сохраняет последнее окно и обновляет только замер входа. Подробности —
[источник окна DSH](dsh-context-window.md).

Ручное сжатие Kimi использует summary: прежняя сессия пишет выжимку, сервер сохраняет
её и ротирует binding. Следующий ход начинает новую сессию с выжимкой. Собственный
`/compact` GrigDesk остаётся в меню, провайдерский дубль удалён. Stop и пустая выжимка
не подтверждают сжатие и не ротируют память. Остальные провайдерские слэш-команды
Kimi остаются отдельным известным ограничением web-транспорта.

Оба факта видны и снаружи: Telegram-пульт использует ту же `contextFill`, а мобильная
карточка — те же поля `contextTokens/contextWindow`.
