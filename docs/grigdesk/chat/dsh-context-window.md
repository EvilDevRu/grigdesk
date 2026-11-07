# Источник окна контекста DSH

Размер окна принадлежит текущему маршруту модели. Каталог DeepSeek/GLM оставляет
`contextRuntimeOnly`: паспортное число не подменяет сведения runtime.

`request/context` содержит provider, model и необязательный contextWindow.
DSH записывает его при изменении маршрута или параметров, включая ёмкость;
событие не обязано приходить перед каждым запросом. Проекция contextPressure
сохраняет последний размер окна, а при отсутствии поля в новом событии удаляет его.
Она доступна в `snapshot.projections.values.contextPressure`.

GrigDesk принимает положительный safe integer типа number через общий
normalizeContextUsage. Полное сообщение с отсутствующим или некорректным окном
даёт `contextWindow: 0`: это отменяет прежний знаменатель при merge и скрывает процент.
Usage не содержит окна и не сбрасывает его. Объём контекста остаётся последней суммой
inputTokens, cacheReadTokens и cacheWriteTokens; уменьшение и измеренный ноль допустимы.
Окно уходит с ближайшим usage-прогрессом и итогом, отдельного progress ради окна нет.

Контракт виден в закреплённых исходниках DSH: agent-loop buildRequest публикует
изменённый request/context, token-meter contextPressureProjectionDefinition удаляет
исчезнувшую ёмкость. Поток session/follow уже ограничен сессией; у request/context
нет attemptId. Код адаптера — server/src/lib/deepseek/serverTurn.ts.

Сторожа: tests/server/glm-runtime.test.js и
tests/server/deepseek-server-thoughts.test.js. Они проверяют snapshot, смену/исчезновение
окна, строгие типы, usage-прогресс и итог. Размер контекста не гарантирует цену запроса.
