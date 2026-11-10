# Factory helpers и статусный протокол payload

В helper catalog зарегистрированы deepseek-runtime-info и factory-status-mcp как script,
deepseek-runner — как main с сохранением runDeepSeekFactory. Main helpers также экспортируют
объявленные bindings. Прямой source guard runner не использует top-level await, поэтому
тот же wrapper можно включить в CJS verification graph без второго запуска CLI.

Compatibility manifest выпускает script import wrappers прежних путей
server/scripts/deepseekRunner.mts и deepseekRuntimeInfo.mts только в staging.
Настоящий Bash runner вызывает probe/catalog через эти wrappers в перенесённом R с пробелами.
Metadata не требует prompt или API key; host contract включён в ресурсы поставки.
Packaged wrapper по умолчанию выбирает binary, без отсутствующего source distribution marker.

Вложенный status MCP выбирается через helperCommand: R/runtime/node/bin/node и
R/server/runtime/helpers/factory-status-mcp.mjs. Env whitelist сохраняет только статусные
поля, включая FACTORY_LOOP_ROLE; ключ провайдера туда не передаётся.

Stage_result принимает nextStage:boolean, stageClosed:string[] и stageSummary:string.
FactoryStatusBoundaryArgs проверяет полный failed result ведущего lead, список закрываемых id
и однострочный summary. Обычный result сохраняет пустые дополнительные argv.
Поля передаются отдельными argv без shell, наряду с findings/deferred/anchors/reviewed.
Hook marker и authority CAS остаются отдельными проверками.

Собранный MCP проверен на настоящем route loop: пять передач, три границы стадий,
закрытие находки исполнителя и выход на gate_accept. Source status-request consumer
применяет deferred requests настоящим run-state writer; неверный token, старый epoch
и чужой run-id сохраняют active record. Сама постановка deferred request не означает,
что authority уже приняла результат.

Helper `factory-runner-models` собирает metadata конвейерных моделей и индивидуальных
уровней effort без model call и записи реестра чатов. Совместимый wrapper
`server/scripts/factoryRunnerModels.mts` относителен перемещаемому комплекту; callback
раннера использует Node закреплённого runtime. Контракт и состав проверки —
[модель и effort этапа](../pipeline/node-model-and-effort.md).

Status port получает `engine/lib/stage-progress.sh` и `stage-result.sh` через общий
`runtimeRoot()`. Относительный `import.meta.url` серверного исходника не сохраняется
в собранном helper: после переноса команды принадлежат `R/engine`.
