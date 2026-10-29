# Native-контракты делегирования GLM

Проверено 27.10.2026 чтением закреплённых исходников Harness и адаптера GrigDesk.
Это факты существующего кода, не подтверждение работы новых возможностей в поставке.
Поведенческие опыты на ELF и их пределы описаны в
[границах субагентов](glm-subagent-boundaries.md).

## Расширение прав ребёнка

`packages/subagent/subagent/src/child-agent.ts`:

- `captureDelegatedPolicyOverrides` переносит явный sandbox override родителя, но
  при наличии approval service задаёт ребёнку `approvalPolicy: 'never'` независимо
  от значения родителя. Разовые разрешения родителя не наследуются.
- `appendDelegatedPolicyOverrides` пишет это в собственный журнал ребёнка после fork seed.
- `SUBAGENT_DELEGATION_CONTEXT` сообщает, что область прав ребёнка фиксирована;
  при нехватке доступа он должен сообщить ограничение делегирующему агенту.

`packages/interaction/user-approval/src/index.ts` отклоняет запрос при `never` до
`approval/request` waterfall. Поэтому отсутствие панели при child escalation объясняется
также native политикой, а не только отсутствием подписки GrigDesk на дочернюю сессию.
Наблюдение событий само по себе эту политику не меняет.

## Вопросы ребёнка человеку

`packages/interaction/user-questions/src/index.ts` разрешает `ask` от агента только
для точного живого корня runtime. Дочерний агент получает `DELEGATED_CALLER` до
waterfall; сообщение требует вернуть нерешённый вопрос в итог родителю. Контракт
проверяется в `packages/interaction/tool-ask-user/tests/tool-ask-user.spec.ts`.
Сессия с историческим родителем, возобновлённая отдельным runtime root, проверяется
по текущему владельцу, а не только по lineage в журнале.

## Окончательная проверка инструмента

В `packages/core/tools/src/index.ts` асинхронная `tools/pre-execute` waterfall может быть
завершена listener-ом без `next`. После разрешающего исхода, включая `serviceAsk`, registry
вызывает синхронные `ctx.tools.guard()` перед dispatch. Guard возвращает причину отказа
или `undefined`; вернуть разрешение, отменяющее отказ другого guard, он не может.
Отмена вызывающего проверяется снова перед dispatch.

Upstream `packages/core/tools/tests/scoped.spec.ts` содержит проверку, что ранний
разрешающий listener не обходит такой guard. Один PreToolUse hook или один listener
`tools/pre-execute` не эквивалентен окончательной проверке. Эта extension point существует
в исходниках; профиль `grigdesk-glm-profile-v3` использует [native gate](glm-native-gate.md).

## Foreground и фон

Оба инструмента standard preset настроены на `backgroundMode: continuable`:
`packages/preset/agent-presets/presets/standard/agent.cordis.yml`.
В `packages/subagent/tool-subagent/src/index.ts` отсутствие `run_in_background`
при такой настройке означает фоновый запуск. `enableRunInBackground: false` убирает
параметр из схемы и отдельно отклоняет принудительный `true` во время исполнения.
Одного удаления параметра из схемы недостаточно: валидатор допускает необъявленные поля.
Foreground путь ждёт результат и dispose ребёнка.

## Каталог, история и связь с вызовом

`packages/subagent/subagent/src/catalog.ts` описывает `subagent/catalog`: child id,
время создания, mode и label; callId делегирования в нём нет. Projection
`subagentCatalog` исключает унаследованные события до `inheritedEventCount`.
`SubagentStartRequest` в `types.ts` также не содержит callId. Foreground tool result
возвращает `run.id` после завершения, а `lifecycle.ts` создаёт ещё отдельный lifecycle runId.
Эти поля нельзя считать готовой связью дочернего live-события с вызовом в ленте.

`packages/api/session-controller/src/history.ts` выдаёт в snapshot только страницу
`records` (default — 50 сообщений), `hasMore`, `cursor` и отдельные `projections`.
Предыдущие события читаются через `session/page`; follow после snapshot выдаёт
непрерывный suffix начиная с cursor + 1. Наличие snapshot не означает наличие всей истории.

## Владение remote-вопросом

`packages/api/gateway/src/stream-protocol.ts` определяет waterfall envelope с
`agentId`, `eventId` и `request`; поля `agent` и `signal` удаляются из request перед
транспортом. Отмена передаётся отдельным `{type: 'cancel', eventId}`. Владелец не
определяется произвольным `request.sessionId`.

При этом `packages/interaction/user-questions/src/types.ts` не включает callId
в question request, а `tool-ask-user` передаёт только вопросы, agent и signal.
Одного remote agentId недостаточно для привязки вопроса к конкретному вызову инструмента.

До профиля `grigdesk-glm-profile-v3` `server/src/lib/deepseek/serverTurn.ts` передавал варианту GLM лишь request,
обрабатывал waterfall без cancel, вызывал autoApprove раньше variant.approve,
а user questions направлял сразу в onPermission. Calls/drafts/usage и awaitingAnswer
также принадлежали одному корневому потоку. Простое добавление child follow к тому же
обработчику не создаёт изоляцию состояния и проверку владельцев.

Профиль `grigdesk-glm-profile-v3` добавляет отдельный [наблюдатель дерева и remote carrier](glm-native-gate.md)
с проверкой владельца до панели и автоодобрения.
