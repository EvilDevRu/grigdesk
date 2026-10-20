# Движок и профили одиночного ELF

Раскладка I/D/R описана в [обзоре сервера](server-binary.md). Закрепление движка
за попыткой и продолжение после обновления — в [контракте кэша](server-binary-cache.md).

`factoryRuntimePaths` (`server/src/lib/factoryRuntime.ts`) выбирает движок фабрики. В режиме
payload это движок поставки `R/engine/bin/factory`: прежние `FACTORY_HOME` и
`GRIGDESK_FACTORY_BIN` из `.env` его не перенаправляют к checkout. Сервер один раз пишет в stderr
имена проигнорированных переменных без значений; `.env` не меняется. Внешний движок включается
только явным `GRIGDESK_ENGINE_MODE=external` с абсолютными путями, иначе
`factory_engine_external_invalid`; неизвестный режим — `factory_engine_mode_unsupported`.
Source и прежний SEA-комплект сохраняют переопределения и умолчание `R/engine`.

Профили payload читаются из физического `realpath(D)/profiles` или явного
`FACTORY_PROFILES_DIR`. Путь с symlink-компонентом, `..` или завершающим `/` отклоняется
`factory_profiles_not_physical` с подсказкой физического пути: движок сверяет `canonical_file`
и запрещает такие компоненты. Профиль не переносится, ссылка `R/profiles` не создаётся.

Замыкание движка в поставке — `engine/bin`, `engine/lib` и `schemas/analytics`
(`server/build/binary-resources.json`): lifecycle и provider lineage читают схемы от
`FACTORY_HOME/../schemas`. Перенесённая копия R без checkout прошла настоящий
`factory check` на минимальном профиле с capability route-v2 в физическом D/profiles;
тот же профиль через ссылку на D движок отверг кодом 78.

Статический каталог этапа GLM, API-допуск и запрет переключения исполнителя по сигнатурам —
[отдельный контракт GLM Factory](../chat/glm-factory-stage.md). Hooks/status MCP используют
[собранные helpers из R](server-binary-factory-helpers.md). Граница bounded initialize
DeepSeek ACP описана [отдельно](../pipeline/deepseek-acp-startup.md); проверка chat/web
не заменяет приёмку этого транспорта на конкретном ELF.
