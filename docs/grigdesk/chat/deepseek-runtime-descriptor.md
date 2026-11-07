# Descriptor и identity runtime DeepSeek

Production resolver выбирает только автономный бинарник: default `bin/deepseek` или
абсолютный `GRIGDESK_DEEPSEEK_BIN`. Web, ACP, каталог, probe и discovery настроек получают
один immutable descriptor. `kind` равен `binary`, `generationDir` — null: распаковкой
владеет ELF. `command` абсолютный, `prefixArgs` закрепляют packageId и cache-dir.

Metadata probe ограничен по размеру и времени; серверный вариант асинхронный. Cache
single-flight учитывает SHA и файловую сигнатуру, поэтому замена по прежнему пути
обнаруживается без перезапуска. Подготовленный handle закрепляет descriptor до prefs,
native context, CAS и prompt. Перед spawn повторно проверяются packageId и файл:
подмена даёт `deepseek_runtime_changed`, без отправки модели и автоматического failover.

`server/scripts/deepseekRuntimeInfo.mts` даёт машинное описание выбранного ELF.
Сервер не импортирует source package и не проверяет ABI Harness относительно своего Node:
worker и generation проверяются внутри поставки. Полный `--verify` всегда проверяет
payload/native modules. Тёплый запуск проверяет состав и kernel fingerprints кэша;
любое изменение переводит его на полный пересчёт.

Identity `deepseek-package:<packageId>` входит в model/native catalog cache и observed
Factory coverage. В профиль прав и home разговора версия поставки не входит:
совместимые обновление и откат сохраняют сессию. Недоступность runtime отвергает ход
до CAS и не сбрасывает память. Подробности — [binary descriptor](deepseek-binary-descriptor.md),
[prepared handle](prepared-executor-runtime.md), [память](deepseek-binary-memory.md).
