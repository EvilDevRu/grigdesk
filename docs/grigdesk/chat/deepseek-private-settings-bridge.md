# Приватный мост настроек DeepSeek

Автономный ELF сохраняет web RPC для чатов и ACP stdio для автоматизации.
Упакованный runtime загружает исходный settings provider/controller в обоих профилях.
Default и override требуют metadata с приватным settings-мостом; stock CLI не допускается.

В ACP initialize capability `_meta["grigdesk.settings"].contract` равна 1. Два приватных
метода `_grigdesk/settings/describe` и `_grigdesk/settings/mutate` регистрируются через
штатный `onRequest(method, parser, handler)` SDK 1.4.0. Мост делегирует controller:
schemas, revision/CAS, validation, persistence и redaction принадлежат upstream.
Методы не объявлены model tools, MCP или публичным HTTP API GrigDesk.

До mutation host перепроверяет принятые поля по существующему нормализованному каталогу.
Это нужно в том числе для неизвестного пути: upstream может сохранить лишний ключ,
который отсутствует в опубликованной схеме. Отказ schema/CAS, неизвестное поле,
неподтверждённый bridge, mismatch и unknown readback блокируют prompt.

ACP применяет overrides в отдельном metadata-only процессе без session/new. Затем
закрывает его и открывает worker из того же уже изменённого приватного документа.
Документ не копируется заново из общего home. Web повторяет процесс при namespace с
`applies: restart`. Оба транспорта перепроверяют readback перед рабочей сессией и после
её создания/возобновления и выбора model/effort. Частичный запуск после ошибки/отмены
закрывается и не переиспользуется.

Readback доказывает принятие слоя сервисом; сам по себе он не доказывает фактический
эффект у владельца. Compiled проверки отдельно подтверждают:

- `llm-deepseek.maxTokens` 64 и 128 меняют `max_tokens` в настоящем HTTP payload
  обоих транспортах на loopback mock API;
- реальный boolean `subagent-model-selection.enabled` сохраняет false отдельно от
  true в base; это web namespace;
- тестовый restart namespace использует исходный provider и владельца, который читает
  значение только при старте: первая mutation меняет readback, а повторный процесс
  меняет владельца; metadata-фаза не делает model HTTP request;
- неподдерживаемые override и изменённый readback после model selection не допускают prompt.

Стенд запрещает fetch за пределы loopback, использует synthetic key и отдельные homes.
Внешние model API для этих проверок не нужны. Source publication gate включает compiled
web/ACP startup, bridge/CAS и проверки фактического HTTP payload.

Для web preset roster host-обёртка задаёт base URL поколения вместо приватного home.
Исходные discovery, validation, shipped/user presets и lifecycle остаются у upstream
service. Это позволяет новой сессии разрешить plugin packages из собственной generation.

## Закрытый профиль в alpha.2

Launcher передаёт штатному ConfigEditor готовые слои GrigDesk в памяти.
Начальный запуск и перезагрузка используют один состав плагинов и ограничений.
Общий `$DSH_HOME/cordis.patch.yml` и менеджер пакетов в этот профиль не входят.
Приватный документ хранит только конфигурацию существующих строк. Смена имени,
добавление строки и новые Loader-выражения отклоняются, а права, модельные
маршруты GLM и служебные hooks сохраняет launcher.

Для одноразового запуска с overrides alpha.2 создаёт файл рядом с приватной
копией `native-settings.yaml` и восстанавливает из этой копии известные разделы.
Metadata worker и рабочий запуск используют один `native-settings.yaml.cordis.yml`.
RPC ждёт завершения начального чтения. Исходная копия остаётся доступной для
отката. Запуск без заданного документа использует отдельный файл в
`$DSH_HOME/grigdesk-profile/<transport>/`. Имя формы
`subagent-model-selection` сохраняется для записанных overrides GrigDesk.

Регрессия `deepseek-alpha-settings.test.js` на собранном ELF проверяет describe,
mutation, CAS, повторный запуск, запрет правки состава Loader и запросы Messages
к loopback. Legacy проверка с `/chat/completions` и тестовым `settings.register`
относится к прежнему runtime.
