# Холодный запуск ACP

Первый `initialize` отдельного DeepSeek ELF включает подготовку runtime. В
`deepseek/src/launcher/main.ts` launcher сначала ждёт `materializePayload`, затем запускает
обычный Node worker через `runLauncherWorker`. На холодном кэше
`shared/node/payloadCache.ts` распаковывает архив, проверяет все файлы и публикует ready marker.
Только после этого worker импортирует host entry, Loader подключает плагины и ACP reader.
Metadata probe сервера вызывает `--runtime-info`, поэтому сам по себе кэш не подготавливает.

Прежние десять секунд на `initialize` учитывали всю эту работу. При холодном запуске ответ
на единственную первую строку пришёл через 10,51 с, при повторном запуске того же ELF с новым
private home и тем же overlay — через 0,97 с. Отсутствие ответа за десять секунд ошибочно
трактовалось как потеря stdin. Проверка с более поздней первой отправкой смешивала разные
состояния кэша и не доказывала дефект overlay или upstream reader.

`initializeDeepSeekAcp` в `server/src/lib/deepseek/nativeSettingsRpc.ts` отправляет ровно один
`initialize` с бюджетом 120 с, таким же, как полный `--verify`. Исходный запрос и его id
сохраняются до ответа или отказа. Повтора по таймауту нет. Ошибки транспорта, завершение
процесса и отмена завершают запуск через существующего владельца процесса. Другие ACP RPC
сохраняют свои сроки; `session/new`, prompt и процесс не повторяются. Бюджет относится к
начальному запуску, а не обещает готовность за фиксированное время: после 120 с остаётся отказ.

Путь stdin проверен отдельно. Launcher передаёт fd 0 worker через `inherit`;
`workerBootstrap.ts` и `dsh-cmdline` подписываются на EOF без `resume` и чтения. Probe sandbox
использует `stdio: ignore`. ACP подключает `Readable.toWeb(process.stdin)` в
`packages/acp/acp/src/index.ts` upstream Harness. В воспроизведённом отказе потери первой строки
нет: она остаётся в pipe до появления reader. Изменения upstream и DeepSeek ELF не требуются.

`tests/deepseek/acpStartup.test.mts` держит настоящий reader за IPC-барьером и продвигает
прежний срок без сна: первая строка принимается ровно один раз. Второй тест проверяет конечный
срок молчащего worker. Модели и ключей в этих тестах нет. `SB26-acp-startup` дополнительно
проверяет отсутствие повторов при ошибках и отмену до записи stdin.

Настоящий упакованный Factory-сценарий находится в `tests/server/binary/factory.test.mts`:
production wrapper и runtime загружаются из `payload.cjs`, модель слушает только loopback,
результат принимает штатный host status consumer. Его отчёт относится только к указанному
SHA серверного ELF; изменение startup budget требует новой сборки и повторной приёмки.
