# Бинарный DeepSeek в Factory

Factory и чат используют один async resolver и один контракт metadata. Служебный
`deepseekRuntimeInfo.mts` принимает явные `--binary` и `--cache-dir`; descriptor
содержит тот же command, prefixArgs, packageId и identity, что чат. Metadata-команды
не выполняют prompt и не требуют ключа модели.

Для binary observed `runnerVersion` включает полный packageId. Разделитель перед
`grigdesk` имеет форму `-grigdesk.`, чтобы общий semver parser сохранял suffix и у
стабильной upstream-версии. Диагностический metadata runtimeVersion не меняется;
переходная embedded-ветка сохраняет прежнюю observed version. Probe, каталог и coverage
видят замену ELF даже при одинаковой generation. Старый probe после A→B даёт
`runtime_changed` до prompt; неизвестный исход не разрешает failover.

`routeLaunchEnv` передаёт host-owned путь ELF и cache поверх extra env. Engine сохраняет
пути отдельными argv, включая пробелы, и передаёт wrapper-у ожидаемые identity/version
и явный cache-dir. Private HOME не заменяет cache-dir.

Wrapper подготавливает opaque handle DeepSeek до чтения prefs. Тот же объект проходит
native settings context и ACP run; смена файла или выбора после prefs отклоняется до
launch и модели. Handle не сериализуется. Настройки перечитываются на каждом узле;
busy snapshot, запрет прямого SSH и headless reject сохраняются.

`deepseekHarnessProbe.mts` использует descriptor prefix/cache, allowlist без credentials
и общий владелец process group. Он делает initialize/new/close без prompt и сообщает
успех после фактического завершения процесса. Ошибка cleanup остаётся ошибкой.

Проверки: `deepseek-runner-identity.test.js`, `deepseek-factory-settings.test.js` и
пять engine DeepSeek contract/unit/integration файлов. Реальные Factory-узлы на ELF
проверяют native overrides, HTTP payload и host status MCP. Отдельные contract doubles
имеют metadata-ветку перед fake ACP; они не используются в SEA/parity. Billing остаётся
`unavailable`, права и capability terminal status принадлежат серверному MCP.
