# DeepSeek: настройки и сборка каждого узла

Factory wrapper читает `PrefsStore.readStored()` перед каждым новым узлом. Единственный
источник overrides — существующий приватный контейнер `providerSettings` с format 1 и CAS.
Busy процесс сохраняет immutable snapshot. Только ENOENT означает отсутствие файла;
повреждённые или недоступные prefs запрещают prompt. Тумблеры прямого SSH/БД из чатовых
настроек к узлам конвейера не применяются: wrapper берёт из prefs только native контейнер,
и в узле (approval `never`) прямой SSH всегда заблокирован дефолтом адаптера.

Сервер явно передаёт `COCKPIT_PROVIDER_PREFS_PATH`, выбранный Node и расположение runtime
обычному spawn и transient systemd service. Эти значения перекрывают extra env. Native
контейнер не передаётся generic provider settings, model shell или project MCP.
Частный ACP мост применяет общие overrides и проверяет readback до рабочей session.
Внешний диагностический runtime без доказанного ACP settings канала при активных overrides
останавливается с `native_settings_unverified`.

Probe и 11-колоночный каталог используют версию вида
`0.1.5-rc.2.cockpit.b<hash16>`. Host coverage сохраняет эту observed версию и сверяет её
перед каждым узлом даже до истечения TTL. Несовпадение, в том числе после штатной
публикации новой сборки, обрабатывается как истёкший снимок: один повтор host preflight и
новая сверка. Узел любого исполнителя профиля встаёт с `coverage_unavailable`, только если
повторный preflight не прошёл или сборка не совпала и после него — тогда маршрут получает
`FACTORY_ERROR=runtime_changed`. Внутри узла dispatcher заново проверяет runtime-sensitive
runner: смена сборки между попытками даёт `runtime_changed` без автоматического failover,
а отказ каталога той же сборки остаётся `invalid_config` или `route_unavailable`.
`catalog_changed` остаётся причиной изменения hash маршрутов. Wrapper закрепляет generation,
identity и runtimeVersion перед prompt. Уже запущенный процесс сохраняет своё поколение.

MCP `stage_progress` и `stage_result` получают host-owned run identity. Настоящий compiled
ACP с loopback API проверен вместе со штатным host status consumer: терминальный результат
закрывает disposable узел. Текст ответа и exit 0 сами по себе статус этапа не создают.
Выбранные engine проверки подтверждают сигналы, timeout, cleanup и прежнюю классификацию ошибок.
