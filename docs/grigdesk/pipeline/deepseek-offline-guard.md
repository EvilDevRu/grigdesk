# Offline-граница DeepSeek runner

Metadata helper DeepSeek запускает выбранную внешнюю поставку. Поэтому engine относит
этот вызов к `provider`, включая `probe` и каталог, даже когда первым executable является
Node, запускающий серверный helper. При `FACTORY_FORBID_LIVE=1` вызов блокируется до helper
с кодом 126; runner сохраняет этот код.
Обычный отказ metadata (нет ELF, stock CLI или несовместимый контракт) переводится
в штатный код 4 недоступного runner для probe и каталога; успешный вывод не меняется.

Имена `deepseek` и `deepseek-*` также входят в запрет исполняемых файлов offline executor.
Объявление такого executable как `local` не обходит запрет. Stock `dsh` и прежние AI CLI
остаются в общем denylist; искать `dsh` как fallback DeepSeek runner не разрешается.

Unit fixtures явно разрешают только свои synthetic executables. Наличие metadata probe
само по себе не является разрешением на живой API вызов.
