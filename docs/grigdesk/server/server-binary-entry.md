# CJS payload и ленивый запуск

`bundlePayloadServer` использует тот же граф реестров и URL plugins, что прежний bundleServer.
Entry — server/src/binary/serverEntry.ts, внешними остаются npm и Node builtin.
Require закреплён через createRequire(__filename), поэтому ordinary Node из другого
каталога и чужой cwd не меняют поиск зависимостей R/server/node_modules.

Payload plugin подменяет runtimeBuildContext на закрытый payloadContext.
До configure чтение путей даёт server_payload_context_missing, смена физических путей —
server_payload_context_changed. Source export configurePayloadContext отказывает.
StartPayloadServer сначала закрепляет контекст, затем лениво импортирует app.ts;
нижний штатный вызов приложения сохраняется и module cache исключает повторный boot.

Маленькая relocated CJS fixture проверяет эти свойства с внешним npm-пакетом и путями
с пробелами. Она не является проверкой размера полного ELF, launcher IPC или cold/warm времени.
