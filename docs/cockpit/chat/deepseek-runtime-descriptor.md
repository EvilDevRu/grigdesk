# Descriptor и identity runtime DeepSeek

Runtime запускается через абсолютный `process.execPath` и `entry.mjs` выбранного
поколения. Production default использует embedded generation. Явный
`COCKPIT_DEEPSEEK_BIN` имеет приоритет для диагностики и отката.

`runtimeProcess.ts` выдаёт неизменяемый descriptor: command, prefixArgs, upstreamVersion,
buildId, runtimeVersion, capabilities, generationDir и identity. Web, ACP, каталог моделей,
проверка установки и discovery нативных настроек используют этот источник. Машинное
представление доступно через `server/scripts/deepseekRuntimeInfo.mts`; candidate передаётся
аргументом `--artifact-dir`.

`runtimeArtifact.ts` проверяет полный payload, относительные ссылки, host/journal contract,
платформу, архитектуру и native ABI Node. Заголовок контракта включён в inputIdentity и
buildId. Изменение dependency при прежнем launcher инвалидирует cache: его сигнатура
охватывает все файлы, каталоги, mode, inode, размеры, mtime/ctime и назначения ссылок.
Ссылка через другую ссылку также обязана оставаться внутри поколения.

Полная проверка обходит ~20 тыс. записей поколения: ~0,1–0,2 с с прогретым cache и ~1 с
при первом хешировании 240 МБ. Поэтому серверные пути (ход чата, discovery настроек,
каталог, probe) вызывают `resolveDeepSeekRuntimeAsync` и
`verifyDeepSeekRuntimeDescriptorAsync`: обход идёт на пуле потоков и не останавливает
остальные запросы. Синхронные версии с тем же контрактом и общим cache остаются для CLI,
wrapper конвейера и скриптов. Привязка сессии, ключ кэша каталога и карточка берут лёгкий
отпечаток (`requireDeepSeekRuntimeIdentity`, `describeDeepSeekRuntime`): выбранное поколение
и buildId из `runtime.json` без обхода файлов. Целостность при этом проверяется перед
каждым запуском процесса. Недоступная сборка даёт отказ хода с безопасной причиной до
сравнения привязки, поэтому сессия чата не ротируется и память агента сохраняется.

Публикация, активация и fork поколений также используют полную асинхронную проверку:
их файловая работа не должна блокировать heartbeat уже запущенного web-процесса.
Подробности — [публикация и event loop](deepseek-publication-event-loop.md).

В embedded-режиме `current` разрешается в поколение внутри `builds` один раз. Отсутствие,
повреждение и несовместимость имеют отдельные причины отказа; автоматического поиска
`dsh` в PATH в этом режиме нет. Наличие Node не доказывает установленный Harness.
`publish-pending.json` блокирует новые запуски до завершения публикации или явного
восстановления. Factory probe и model snapshot используют версию с `.cockpit.b<hash16>`;
перед каждым узлом проверяются текущая identity и coverage, даже внутри прежнего TTL.

Native settings context закрепляет descriptor на время discovery; версия источника
берётся из upstreamVersion, а buildId хранится отдельно. Подготовленный settings snapshot
с другой runtimeIdentity отвергается до session/prompt. Смена `current` не меняет argv уже
выбранного поколения. Identity также входит в cache каталога моделей, profile fingerprint
настроек и security/session binding. Приватный home embedded-процесса разделён по buildId;
предыдущие homes и поколения сохраняются. Пользовательские model ID и формат истории не меняются.

Поведенческие проверки используют малые артефакты с настоящим форматом hashes и свежую
сборку upstream: перенесённый web-процесс авторизуется cookie и отдаёт settings RPC,
а ACP initialize сохраняет JSON-RPC stdout без API key и без prompt.
