# Допуск GLM из бинарной поставки

Конкретные записи допуска принадлежат `deepseek/compatibility/glm.json`. Producer пакета
замораживает список и записи перед сборкой metadata. Сервер хранит политику разрешённых
режимов, ревизии профиля/политики и формулу compatibility; конкретные identity в него
не зашиты. Default adapter читает admission каждого актуального binary descriptor.

Binary probe, каталог и run используют metadata выбранного ELF без чтения сервером
файлов распакованной generation. Допуск требует совпадения всех входов compatibility,
ревизий и записи выбранного режима. Пустой список или несовпадение дают отказ до модели.
Политика разрешает `api` и `coding-plan`. Допуск Coding Plan требует полного
[успеха smoke выбранного выпуска](glm-coding-plan-smoke.md). Старый ELF только с admission `api`
продолжает отказывать Coding Plan: новый список нужно включить в metadata выпуска.
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
Они не меняют список выпуска. Production default использует только admission из metadata,
а тесты отказа задают пустой список или несовпадающую запись явно.

Установщик и updater сверяют допуск фактического режима потребителя: `--glm-mode`
передаёт установившая сторона (`grigdesk-ctl build deepseek` берёт его из настроек
службы). Рантайм по-прежнему требует admission выбранного режима на каждом запуске,
поэтому требование режима, которым машина не пользуется, не добавляет защиты.
Живой smoke `server/scripts/glmLiveSmoke.mts` запускается человеком для любого
разрешённого режима (`--mode api|coding-plan --confirm-live`); флаг `--admit` после
полного успеха дописывает проверенную запись в `deepseek/compatibility/glm.json`
той же рабочей копии, а следующая сборка замораживает новый список в metadata.

Preflight `deepseek/scripts/admissionPreflight.mts` считает identity входов дерева той же
`glmRuntimeIdentity`, что и сборка, и отвечает CLI, нужен ли вопрос о живом smoke.
Авторитет допуска остаётся за `admission:check` собранного кандидата. Любая правка входов
билдера, включая сам `buildRuntime.mts`, устаревляет записи допуска до нового живого
smoke с `--admit` и следующей сборки. Подробности — [preflight допуска](glm-admission-preflight.md).
