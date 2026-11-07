# Descriptor автономного DeepSeek

Resolver поддерживает `binary` и явный `GRIGDESK_DEEPSEEK_BIN`. Он запускает выбранный
абсолютный executable только с `--runtime-info --json`, без runtime prefix, HOME,
provider credentials и Node loader inputs. Metadata probe ограничен десятью секундами
и 64 KiB вывода. Отсутствие, права запуска, timeout, превышение вывода, повреждённая
metadata и неподдержанный бинарник имеют разные безопасные коды отказа.

Contract 1 проверяется по установленному `server/deepseek-host-contract.json`, платформе,
архитектуре и обязательным capabilities. Новая upstream version разрешена при совместимом
контракте. ABI серверного Node не сравнивается с ABI упакованного worker. Stock `dsh`
не принимается по имени или версии: отказ указывает команду установки бинарника.

Descriptor `kind: binary` содержит command, публичную metadata и identity
`deepseek-package:<packageId>`. Capabilities берутся из metadata, включая settingsAcp
для override. Prefix закрепляет `--expect-package-id` и server-owned `--cache-dir`;
generationDir равен null, распаковкой владеет сам ELF.

`deepseekCacheDir` в конфигурации задаётся из раскладки папки данных, а не из prompt.
Настоящий ELF проверен через verify, web settings, ACP settings, каталог и loopback chat:
payload появляется только в выбранном cache, отдельный parent HOME не изменяется,
невыбранный default cache не создаётся. Окружение запуска проходит прежний allowlist
Harness; чужой ключ и NODE_OPTIONS не передаются.

Production default и override используют только binary. Режимы installed/external
удалены; resolver никогда не ищет `dsh` в PATH и не запускает legacy entry.
