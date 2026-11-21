# Агентский CLI pipeline

pipeline — отдельный Linux x64 ELF управления опубликованными конвейерами через API GrigDesk.
Node/curl/jq ему не нужны. Работающий сервер и CLI-токен нужны для API-команд;
настройки GRIGDESK_URL/GRIGDESK_TOKEN/GRIGDESK_HOME общие с tracker.
Исходники и сборка двух CLI находятся в tracker/; tracker сохраняет свои прежние команды.

Публичные операции из терминала проходят через `pipeline` и API.
Служебный `bin/factory` запускает проверку профилей и выбранный сервером runtime.
При продолжении API читает pin этой попытки и её исходный хеш маршрута.

## Чтение

- pipeline list
- `pipeline status <task>`
- `pipeline state <task>`
- `pipeline graph <task>`
- `pipeline doc <task> <plan|recon|diag|ship|report|audit|review>`
- pipeline profiles
- pipeline runners
- `pipeline slots <profile>`
- `pipeline source <board>`
- `pipeline launch-options <task> <profile> <source>`
- `pipeline runner-options <task> <profile> <attempt> <node> <stage> <provider>`
- `pipeline arbiter-current <task>`
- `pipeline arbiter-show <task> <conversation> [afterSequence] [knownRevision]`
- `pipeline arbiter-journal <task> <conversation>`

Чтения возвращают JSON; journal — текст. `pipeline prelude-state <task>` возвращает read-only
attempt/profile/terminal независимо от cursor и actionable identity для подготовительной фазы.
На terminal actionable identity=null. wait использует trusted terminal, даже когда main cursor не было. doc добавляет basis:{name,hash}.
launch-options возвращает {options,expectedLaunch}; options.catalogHash передаётся в
expectedCatalogHash. Пагинацию arbiter-show продолжает вызывающий по hasMore; одна страница
не является полной историей. Старые остановки доступны по сохранённому conversationId.

## Управление

Все команды ниже принимают JSON-объект из stdin, максимум 256 КиБ.

- `pipeline launch <task>`: profile,route,source,expectedCatalogHash,expectedLaunch +
  объявленные LaunchOptions (описание, критерии, deliveryTargets и прочее).
- `pipeline stop <task>` и `pipeline resume <task>`: expectedMobile из state;
  до основного cursor — expectedPrelude из prelude-state. Он содержит profile,attempt,orchPid,
  bootstrap:null либо {visitId,stopHash,state,decisionHash}; два вида identity не смешиваются.
- `pipeline goto <task> <KEY>`: expectedMobile,comment.
- `pipeline gate <task> <GATE_KEY> <approve|reject>`: expectedMobile,comment при reject;
  optional expectedBasis={name,hash} для plan/report/diag.
- `pipeline runner-set <task>`: StageRunnerApply из настроек этапа, включая expectedRevision,
  expectedRun,catalogRevision,requestId,mode=next|restart,selection.
- `pipeline bootstrap-answer <task>`: profile,attempt,phase=bootstrap,node=scout,
  visitId,stopHash,answer. Это сохранение ответа; продолжение — отдельный resume.
- `pipeline runtime-rebind <task>`: expectedMobile.
- `pipeline arbiter-start <task>`: requestId UUID,expectedStop из arbiter-current.
- `pipeline arbiter-message <task> <conversation>`: requestId,expectedStop,decisionRevision,
  text либо questionId с optionId/customAnswer.
- `pipeline arbiter-diagnose <task> <conversation>`: те же основы и proposalId диагностики.
- `pipeline arbiter-apply <task> <conversation>`: те же основы и proposalId либо customAction;
  optional originalProposalId сохраняет исходный выбор.
- `pipeline arbiter-resume <task> <conversation>`: requestId,applyOperationId,acceptedEvent,
  expectedCurrentStage; это повтор продолжения уже записанного решения.
- `pipeline arbiter-stop <task>`: operationId текущего читающего хода.

Поля identity/requestId сохраняются между чтением и действием. CLI не выбирает latest,
не меняет source на default и не повторяет POST после ошибки. Устаревший снимок даёт отказ.
Повтор того же arbiter requestId допустим только с тем же payload: идемпотентность хранит сервер.
202 queued означает сохранённую операцию, а не результат модели/исправления.
Человек явно поручает gate/apply/restart; обычное сообщение арбитру разрешением не является.
Отдельного флага подтверждения, заменяющего поручение человека, нет.

## Ожидание и ошибки

`pipeline wait <task> <attempt> [timeoutMs] [intervalMs]`
По умолчанию 600000/2000 мс. Возвращает outcome=terminal|human|stopped|timeout.
terminal содержит фактический исход из trusted identity либо read-only prelude authority.
Поле terminal возвращается отдельно даже при identity=null; оно не обещает успешной приёмки.
Готовый курсор без живого процесса не объявляется завершением.
SIGINT/SIGTERM останавливает клиентское ожидание, принятый сервером job продолжается.

Коды: 0 запрос/наблюдение; 1 настройки/I/O; 2 argv/stdin; 3 частично выполнено;
22 HTTP/сеть/повреждённый ответ; 124 срок ожидания; 130 отмена.
При 3 и 124 JSON остаётся в stdout. Остальные отказы оставляют stdout пустым,
русская причина идёт в stderr. При 3 повторяют только несостоявшееся продолжение.
При потере ответа сначала проверяют состояние: операция могла уже выполниться.

## Сборка и поставка

`pipeline` собирается с Go 1.27.4 командой
`bash tools/build-go-utilities.sh "$PWD/bin/utilities"`. В checkout
`grigdesk-ctl pipeline` находит `bin/utilities/pipeline` рядом с собой. Установщик
создаёт `~/.local/bin/pipeline` после проверки бинарника.

В подписанной local/server-установке `grigdesk-ctl pipeline` проверяет
`bin/pipeline` из `current.server`. Следующий вызов после обновления
выбирает новое поколение.
Папки данных задаёт receipt; явные GRIGDESK_URL/GRIGDESK_TOKEN сохраняют обычный приоритет.
Аргументы, stdin/stdio, сигналы и код выхода сохраняются. Нет server/ELF или путь небезопасен —
отказ1, без поиска source, PATH либо другого поколения. Установка remote без server не поддерживает этот вход.
В dev-дереве с локально собранным bin/grigdesk-server вход grigdesk-ctl pipeline, как и tracker,
требует готовый `bin/utilities/pipeline` и при его отсутствии отказывает кодом 1.
