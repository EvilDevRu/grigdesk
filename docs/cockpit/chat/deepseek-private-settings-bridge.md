# Приватный мост настроек DeepSeek

Встроенный candidate сохраняет web RPC для чатов и ACP stdio для автоматизации.
Сокращённый runtime загружает исходный settings provider/controller в обоих профилях.
Production default — встроенная сборка. Внешний Harness (`COCKPIT_DEEPSEEK_BIN` или
релиз с `mode: installed`) такого моста в ACP-профиле не предоставляет.

В ACP initialize capability `_meta["cockpit.settings"].contract` равна 1. Два приватных
метода `_cockpit/settings/describe` и `_cockpit/settings/mutate` регистрируются через
штатный `onRequest(method, parser, handler)` SDK 1.4.0. Мост делегирует controller:
schemas, revision/CAS, validation, persistence и redaction принадлежат upstream.
Методы не объявлены model tools, MCP или публичным HTTP API Cockpit.

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
