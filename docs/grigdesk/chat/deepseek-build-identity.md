# Identity generation DeepSeek

BuildId — SHA256 сериализованных `inputIdentity` и `payload`. В inputIdentity входят
код сборки, composition, exact runtime lock, платформа/ABI и исходные входы. Payload
содержит каждый файл с его mode, а также внутренние относительные symlinks.
Проверка generation повторно сверяет весь этот набор.

Служебные `.tsbuildinfo` входят в payload и в проверку целостности. Они могут меняться
при переносе путей compiler dependencies даже при одинаковых исполняемых файлах.
Правки import/default путей сборщика меняют также hash его кода. Поэтому перенос пакета
может давать новый buildId без изменения upstream или composition revision.

Сравнение runtime до и после переноса допускает различия `.tsbuildinfo`, но проверка
целостности каждого полученного артефакта остаётся полной. Подставлять прежний buildId
или исключать compiler metadata из integrity нельзя.

Native ABI, байты runtime lock и patches, composition revision и compatibility GLM
проверяются отдельно. GLM compatibility не включает расположение builder или buildId;
прежнее значение не даёт допуска режиму, если оно отсутствует в записи admission.
