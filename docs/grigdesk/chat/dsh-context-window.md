# Источник окна контекста DSH

Проверено 30.10.2026 по закреплённым исходникам DSH и адаптеру GrigDesk.
Это контракт источника данных; чтение этих полей адаптером на момент проверки
ещё не реализовано.

## Snapshot и изменение маршрута

`request/context` содержит provider, model и необязательный contextWindow.
DSH записывает событие при изменении маршрута или параметров, включая ёмкость;
оно не обязано приходить перед каждым обращением к модели. У события нет attemptId.

Проекция contextPressure хранит последнее окно из request/context. Если новое
событие не содержит contextWindow, проекция удаляет прежнее значение. Она доступна
в `snapshot.projections.values.contextPressure`. События session/follow уже
ограничены указанной сессией: дополнительный фильтр по attemptId здесь неприменим.

Числитель и знаменатель проекции — независимые последние значения. pressureTokens
описывает последний измеренный вход, projectedTokens оценивает последующий контекст
с учётом изменений поверхности. Их нельзя выдавать за один атомарный замер запроса.

## Состояние адаптера GrigDesk

`server/src/lib/deepseek/serverTurn.ts` сейчас читает contextWindow из usage-чанка,
хотя TokenUsage DSH не содержит такого поля. Snapshot и request/context для окна
не обрабатываются. Диагноз и границы — [пробелы кольца](context-wheel-executor-gaps.md).

Общий `shared/chat/chatContextUsage.ts` принимает только safe integer типа number;
строки, boolean и массивы не превращаются в числа. Он сохраняет явный 0 и опускает
отсутствующее поле. Поэтому простое отсутствие окна в частичном обновлении не
инвалидирует ранее известную ёмкость у потребителя, выполняющего merge.

## Где проверять контракт

Все пути DSH ниже относительно `deepseek/vendor/deepseek-harness/upstream/`:

- `packages/core/agent-loop/src/agent.ts`, buildRequest, якорь
  `const previousContext = session.requestContext()` — условие публикации события.
- `packages/llm/token-meter/src/usage-projection.ts`,
  contextPressureProjectionDefinition — независимые последние значения и удаление окна.
- `packages/core/session/src/types.ts`, RequestContext — состав полей события.
- `packages/api/session-controller/src/history.ts`, session/follow — ограничение сессией.

Размер контекста не гарантирует цену запроса: [контекст и prompt cache](context-cache-and-compaction.md).
