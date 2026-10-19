# Допуск GLM из бинарной поставки

Конкретные записи допуска принадлежат `deepseek/compatibility/glm.json`. Producer пакета
замораживает список и записи перед сборкой metadata. Сервер хранит политику разрешённых
режимов, ревизии профиля/политики и формулу compatibility; конкретные identity в него
не зашиты. Default adapter читает admission каждого актуального binary descriptor.

Binary probe, каталог и run используют metadata выбранного ELF без чтения сервером
файлов распакованной generation. Допуск требует совпадения всех входов compatibility,
ревизий и записи выбранного режима. Пустой список или несовпадение дают отказ до модели.
Coding Plan закрыт серверной политикой даже при соответствующей записи в metadata.
`llmPiAi: null` означает отсутствие объявленного GLM plugin и даёт `glm_plugin_missing`;
частично повреждённая структура metadata отвергается декодером.

Проверку bytes выполняет `--verify` самого ELF: общий payload и generation проверяются
полностью, включая plugin. Повреждение plugin в отдельной копии cache даёт exit 1 и
безопасный JSON ошибки; восстановление исходных bytes и mode возвращает успешный verify.
Сервер не подменяет эту проверку чтением plugin-файлов.

Явный override принимает нашу поставку с host contract; stock CLI отвергается без
fallback. Cache key каталога включает packageId, mode и отпечаток ключа. Registry,
загруженный до первой установки, видит появившийся ELF тем же adapter без рестарта;
способность run разрешённого режима не зависит от наличия файла при загрузке модуля.

Offline-тесты могут явно передать test admission, loopback endpoint и egress guard.
Они не меняют список выпуска. Политика binary-ветки по-прежнему запрещает Coding Plan;
production default использует только admission из metadata.
