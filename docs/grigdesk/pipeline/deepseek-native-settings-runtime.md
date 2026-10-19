# DeepSeek: настройки и сборка каждого узла

Factory wrapper читает `PrefsStore.readStored()` перед каждым новым узлом. Единственный
источник overrides — существующий приватный контейнер `providerSettings` с format 1 и CAS.
Busy процесс сохраняет immutable snapshot. Только ENOENT означает отсутствие файла;
повреждённые или недоступные prefs запрещают prompt. Тумблеры прямого SSH/БД из чатовых
настроек к узлам конвейера не применяются: wrapper берёт из prefs только native контейнер,
и в узле (approval `never`) прямой SSH всегда заблокирован дефолтом адаптера.

Сервер явно передаёт `GRIGDESK_PROVIDER_PREFS_PATH`, выбранный Node и расположение runtime
обычному spawn и transient systemd service. Эти значения перекрывают extra env. Native
контейнер не передаётся generic provider settings, model shell или project MCP.
Частный ACP мост применяет общие overrides и проверяет readback до рабочей session.
Default и override со stock CLI без metadata отвергаются до запуска; metadata без
обязательного ACP bridge также несовместима. Активные overrides не игнорируются.

Probe и 11-колоночный каталог используют версию вида
`<runtimeVersion>.p<packageId>`; packageId полный
и сохраняется общим parser даже при стабильной upstream-версии.
Host coverage сохраняет эту observed версию и сверяет её
перед каждым узлом даже до истечения TTL. Несовпадение, в том числе после штатной
публикации новой сборки, обрабатывается как истёкший снимок: один повтор host preflight и
новая сверка. Узел любого исполнителя профиля встаёт с `coverage_unavailable`, только если
повторный preflight не прошёл или сборка не совпала и после него — тогда маршрут получает
`FACTORY_ERROR=runtime_changed`. Внутри узла dispatcher заново проверяет runtime-sensitive
runner: смена сборки между попытками даёт `runtime_changed` без автоматического failover,
а отказ каталога той же сборки остаётся `invalid_config` или `route_unavailable`.
`catalog_changed` остаётся причиной изменения hash маршрутов. Wrapper закрепляет opaque
runtime handle до prefs и передаёт его native context и ACP run. Подмена ELF после prefs
останавливает узел до prompt. Уже запущенный процесс сохраняет своё поколение.
Подробности — [бинарная Factory-ветка](deepseek-binary-factory.md).

MCP `stage_progress` и `stage_result` получают host-owned run identity. Настоящий compiled
ACP с loopback API проверен вместе со штатным host status consumer: терминальный результат
закрывает disposable узел. Текст ответа и exit 0 сами по себе статус этапа не создают.
Выбранные engine проверки подтверждают сигналы, timeout, cleanup и прежнюю классификацию ошибок.
