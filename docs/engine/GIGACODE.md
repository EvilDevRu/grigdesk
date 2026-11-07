# GigaCode в Factory

**Временно отключён для выпуска 0.1.0.** Shell-модуль сохранён как
`engine/lib/runners/gigacode.sh.disabled`, поэтому реестр `*.sh` его не обнаруживает.
Мосты и экспериментальные проверки также сохранены с суффиксом `.disabled`.
`tests/engine/unit/gigacode-disabled.sh` проверяет отсутствие раннера в настоящем реестре.
Возвращение требует отдельного включения и успешных интеграционных проверок;
дальнейший текст описывает подготовленные исходники, а не доступный сейчас запуск.

Runner `gigacode` автоматически обнаруживается по shell-модулю и использует общий
с чатом ACP runtime. Подтверждена поставка 26.7.33; подробности версии, доступа и
ограничений — в [контракте CLI](../grigdesk/chat/gigacode-cli-contract.md).

## Запуск и доступ

Поддерживается запуск из исходников; в комплекте сервера (packaged/SEA) GigaCode
пока не поддерживается. Runner требует явный абсолютный исполняемый
`GRIGDESK_GIGACODE_NODE_BIN`: без него probe возвращает 4 до provider process.
Общие NODE_BIN и PATH не заменяют это разрешение. Бинарник SEA-сервера нельзя
передавать как Node: в комплекте запуск конвейера не выдаёт эту переменную, и probe
отказывает кодом 4. Точки упаковки GigaCode в SEA-инвентаре имеют судьбу `deferred-gigacode`.

`gigacode.sh` реализует восемь методов runner, default_policy и default_effort.
Probe проверяет установку и наличие native OAuth cache, не отправляя prompt.
Catalog строится из того же metadata discovery, что каталог чата; family равна
opaque id. Default policy выбирает первую модель подтверждённого каталога.
Exact id и явное неподдерживаемое effort не подменяются. Native resume выключен.

Необязательный credential_fingerprint разделяет breaker по профилю и native
credential snapshot. Persisted catalog без такого binding не используется:
для нового resolve перечитывается metadata. Токен наружу не выводится.
Отсутствие effort сохраняется и после resolver, на переходе к launcher.
Этот hook не меняет прежний default high у раннеров, которые его не объявляют.

Версия 26.7.33 проверена, новая версия CLI допускается при том же имени пакета
и ACP v1. Каталог не ограничен точным semver; фактическая версия записывается
в CLI_VERSION попытки и run_start. Карточка провайдера предупреждает о непроверенной
версии; в интерфейсе GigaCode представлен обычной буквой `G`.

Host wrapper получает prompt через private-файл 0600, запускается через
`factory_exec provider` и ограничен `timeout -k 30`. Barrier, slots, статус,
retained journal и окончательный meta.env принадлежат общему launcher.
Runtime принимает сигналы wrapper и завершает только собственную namespace.

Чатовые тумблеры SSH/БД в Factory не передаются. Runtime сохраняет запрет прямого
SSH по умолчанию; для этой поставки GigaCode это отключает native
`run_shell_command` и `web_fetch` целиком. Файловые tools и status MCP работают, но выполнение
сборочных команд через native shell пока недоступно. Этот запрет не заменяется
обещанием фильтровать shell по тексту команды.

Переменные BIN/HOME/RUNTIME_HOME/BWRAP_BIN с префиксом `GRIGDESK_GIGACODE_`
передаются обеим веткам отвязанного запуска — systemd и fallback. Это пути,
а не секреты; под тем же uid читается ровно native cache. Нового env API key нет.
Уже работающий процесс удерживает прежний snapshot, следующий читает новый.
Private home содержит readonly owner (pid и поле starttime из /proc). Перед созданием
следующего home удаляются только turn-каталоги с доказанно мёртвым владельцем
или повторно использованным PID. Возраст не используется; живые и неразобранные
записи остаются. Подробности — [в контракте очистки](../grigdesk/chat/gigacode-private-home-recovery.md).

## Файлы и статус

`state-only` открывает code root readonly, а запись — только в task-scoped каталог
`reports/t<task>` каталога состояния и private temp/home. `workspace-write`
дополнительно открывает cwd на запись. Весь STATE_DIR агенту не монтируется.
Если cwd или дополнительный readable root содержит весь STATE_DIR, wrapper
отклоняет запуск до prompt; вложенный в исходники state не становится доступным.
`RUNNER_GIGACODE_ADD_DIRS` содержит дополнительные readable roots, разделённые
переводом строки. Пробел внутри пути не становится разделителем. Неизвестная
filesystem policy закрывает запуск до prompt.

Обязательный `factory-status` использует общий host-owned status port. Модель
передаёт только поля `stage_result`/`stage_progress`, writers вызываются на host
вне provider namespace. Identity task/stage/run/epoch и loop role берутся из
доверенного окружения. Готовность tools/list проверяется до prompt.

Терминальные результаты — `done|skipped|failed`; human задаётся failureOwner.
Findings, deferred findings, anchors, reviewed и граница этапа цикла сохраняются
штатным stage-result. `nextStage=true`, `stageClosed[]`, `stageSummary` доступны
только host роли lead и проходят каноническую проверку failed + blocking findings.
Progress использует штатный allowlist, не завершает стадию и не даёт ROUTE_BY=human.
Rc=0 и текст «готово» без принятого статуса заканчиваются missing_status.

## Классификация и capabilities

Объявлены `status status_request tools structured_output`. `sandbox` execution
planner, status_fd, fanout и native_resume_v1 не объявлены. Поэтому single разрешён,
parallel/forbid недоступен, parallel/allow-single получает явную деградацию fanout.
Agent/Skill выключены; fanout_count всё равно считает уникальные реальные tool ids
из JSON, включая update-only событие. Описание Agent в тексте не является вызовом.

Host events имеют schema `gigacode-acp-v1`. Rc=0 даёт ok, 124 — timeout. Переключаемым
provider_unavailable является только подтверждённый локальный pre-prompt отказ
доступа/установки без activity. Повреждённый поток, неизвестная версия и остальные
ошибки остаются unknown. Для тарифов/remote 401/429/overflow доказанных положительных
сигнатур нет; совпавшие слова в tool output ничего не классифицируют.

Billing counters не доказаны и не регистрируются как измеренные нули. Диагностика
не зависит от billing: общий finalizer анализирует тот же удерживаемый events fd,
очищает code/message и единолично публикует FAILURE_* в meta.env. Dispatcher и
карточка остановки используют общий контракт этих полей.

## Offline-проверки

Fake CLI заменяет только внешнюю границу. Настоящие runtime, bwrap, MCP, writers,
launcher, resolver и dispatcher остаются в цепи. Отдельный host HTTP observer
считает prompt независимо от файлов, доступных fake. Синтетический дочерний env
снимает guard только после проверки fixture paths; guard всего suite остаётся.

```bash
TEST_JOBS=2 bash tests/engine/run-offline.sh '/gigacode-[^/]*\.sh$'
```

При FACTORY_FORBID_LIVE=1 executor блокирует provider и даже ошибочный local basename
gigacode/gigacode-*, прямой tripwire возвращает 97. Живой корпоративный model call
не входит в offline-доказательство и проходит отдельную приёмку с доступом.
