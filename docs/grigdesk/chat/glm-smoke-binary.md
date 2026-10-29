# Проверка GLM с явно выбранным бинарником

`server/scripts/glmLiveSmoke.mts` требует `--mode api --confirm-live --binary <абсолютный ELF>
--cache-dir <отдельный абсолютный cache>`. Проверка аргументов предшествует чтению env.
Настройки службы не подменяют выбранный ELF или cache-dir; инструмент использует async
descriptor и metadata generation. Потолок остаётся восемь ходов.

Только этот явный entrypoint рассчитывает временный DI-допуск для api. Серверная проверка
host contract, profile/policy и наличия plugin сохраняется. Coding Plan отклоняется до
файловых эффектов. Обычный production adapter продолжает проверять admission самого выпуска.
Способ чтения ключа для ручного запуска сохранён: env-файл папки данных поверх окружения;
ключ не передаётся в argv и не печатается.

Тест не предполагает, что production admission всегда пуст: допущенный api ELF работает
без DI, несовместимая identity отклоняется до процесса. Проверка остаётся offline:
[фикстура допуска выбранного выпуска](../testing/glm-release-admission-fixture.md).

Отчёт содержит kind (`loopback` для локального model endpoint, иначе `live`), mode,
compatibility, packageId и SHA выбранного файла. Offline-тест передаёт синтетический ключ,
loopback модель и fetch guard; ветка main, читающая env-файл, не вызывается. Этот результат
проверяет инструмент и протокол, живого допуска выпуска он не выдаёт.

`modelErrors[]` содержит [HTTP-статус и полный очищенный текст модельного отказа](glm-smoke-http-errors.md).
Сетевому исключению соответствует `httpStatus: null`. После неуспешного первого ответа
smoke останавливается; оставшиеся ходы не выполняются.

`tests/server/glm-live-binary.test.js` использует настоящий ELF: ответ, read/write/bash,
reasoning, resume, foreground критика с дочерней лентой, запрет SSH, остановка в approval и duplicate turnId. У model fixture
отдельные callId, а путь для approval извлекается из строки перед добавленной подсказкой
GrigDesk. Проверка CLI с неполными аргументами не запускает модель и не читает env.
