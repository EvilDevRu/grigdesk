# Native gate и foreground-делегирование GLM

Профиль чата `grigdesk-glm-profile-v3` и политика `grigdesk-glm-policy-v2` используют
host plugin `deepseek/src/host/glmGate.mjs`. Factory и ACP-каталог сохраняют прежнюю
hook-политику. Наличие реализации не заменяет допуск конкретного ELF через живую проверку.

## До эффекта инструмента

Асинхронный `tools/pre-execute` запускает `glmToolPolicyHook --native-gate` с таймаутом
30 секунд. Helper наследует scrub окружение и песочницу shell service; ключ маршрута
ему недоступен. Политика находится в приватном каталоге запуска и связана SHA256.

Компактный JSON proof связывает формат, consumer, launchId, policyHash, sessionId,
agentId, turn, callId, имя и SHA256 канонических аргументов. Parser отвергает лишние
поля, повтор ключей, повреждение, превышение размера и несовпадение любой привязки.
Окончательный `ctx.tools.guard()` требует proof на **том же объекте execution** через
WeakMap, заново сверяет аргументы и отмену. Ранний разрешающий listener без `next`
не обходит guard. Сам registry замораживает аргументы: попытка изменить их завершается
ошибкой инструмента до body.

Отказ политики возвращается модели. Поломка gate пишет `grigdesk/glm-policy-error`
также в корневую сессию, отменяет дерево и закрывает новые эффекты процесса. Сервер
обрабатывает audit раньше terminal, поэтому такой отказ не маскируется обычным стопом.

Metadata содержит `capabilities.glmNativeGate`; composition identity включает SHA256
входов сборки, в том числе host plugin, протокол и преобразование preset. До prompt
сервер отдельно ждёт `grigdesk/glm-ready` именно своего launch, policy и root session.
Старая запись журнала и одна декларация metadata готовность не подтверждают.

## Дочерние сессии

Preset `grigdesk-glm` копируется из закреплённого standard при сборке. У `subagent`
и `subagent_fork`: `enableRunInBackground: false`, `backgroundMode: one-shot`,
`modelSelectionSettings: false`, `maxDepth: 3`. Helper дополнительно отвергает background
и provider/model/reasoning_effort overrides. Остальные будущие инструменты остаются закрыты.

Ребёнок наследует маршрут, effort, cwd, инструкции и preset. Его штатные ограничения
сохраняются: `approvalPolicy: never`, вопросы человеку — `DELEGATED_CALLER`.
Недостающие права и вопросы ребёнок сообщает родителю; родитель делает собственный вызов.

AsyncLocalStorage вокруг `tools/execute` связывает конкретное делегирование с созданием
ребёнка. Parent-owned `grigdesk/glm-delegation` содержит точный parent call и child identity.
Каталог появляется раньше native `subagent/descriptor`: поэтому связь для follow публикуется
после descriptor, до первого запроса дочерней модели. Угадывание по label не используется.

## Журнал, лента и вопросы

Четыре события `grigdesk/glm-*` входят в статический persistence vocabulary собираемого
runtime. Без этого первый ход работает, но resume отвергает журнал как неизвестный.
Сборщик меняет только staging; исходный upstream cache не редактируется. Новые события
не становятся сообщениями модели и не запускают старые инструменты при восстановлении.

Наблюдатель проверяет каталог, proof делегирования и непрерывность seq; ранние страницы
snapshot дочитываются с постоянным throughSeq. Ready собственной сессии отделяет seed
fork и старый launch. Child steps имеют детерминированные id и parent вызова делегирования.
Live block-end и durable message не дублируются. Повторная попытка в том же turn/step
получает отдельный номер settlement; оборванный prefix восстанавливается также из журнала.
Child terminal, текст, модель и usage
не заменяют корневой ответ или контекст. Итог ждёт дочерние terminal suffix.

Remote envelope проверяется по agentId и активному call до UI и автоодобрения служебного
MCP. Для root question native bridge добавляет proof из текущего execution: в штатном
question request нет callId. Pending изолированы по clientId/eventId, показываются по
очереди и отменяются своим signal. Cancel, stop, конец хода и потеря carrier закрывают
ожидания; поздний ответ не уходит в новое поколение. F5 окна не закрывает серверный pending.

Проверки: `glm-vendored-{gate,subagents}`, `glm-native-guard`, `glm-tree-observer`, `glm-child-presentation` и
`glm-gate-protocol`; ELF-наборы включены в binary parity и compiled candidate gate.
