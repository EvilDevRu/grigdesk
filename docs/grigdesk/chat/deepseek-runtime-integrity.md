# Целостность generation и выбранный Node

`shared/node/deepSeekArtifact.ts` проверяет полный manifest и payload generation:
buildId, contract, mode и содержимое файлов, относительные ссылки и их цепочки.
Служебные `.tsbuildinfo` остаются частью payload. Лишний или отсутствующий файл
считается повреждением. Алгоритм отпечатка не зависит от расположения verifier.

Вызывающий передаёт ожидаемые nodeVersion, platform, arch и nativeAbi явно.
Совместимость проверяется также при попадании в integrity cache: проверка с ABI
одного worker не разрешает исполнение тем же каталогом под другим ABI.

Legacy wrapper `server/src/lib/deepseek/runtimeArtifact.ts` передаёт параметры
Node сервера. Wrapper пакета `deepseek/src/runtime/artifact.ts` получает параметры
выбранного worker. Его ABI может отличаться от ABI Node сервера; именно совпадение
worker с generation обязательно. Общая политика поддерживаемых версий Node живёт
в `shared/runtime/nodeVersion.ts`, сервер сохраняет свой прежний публичный API.

Для серверных запросов полная проверка остаётся асинхронной: файловый обход и
чтение payload не блокируют event loop. Синхронный вариант предназначен для CLI.
