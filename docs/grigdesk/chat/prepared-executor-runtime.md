# Подготовленный runtime исполнителя

Адаптер может объявить `prepareRuntime(config, { signal })`, возвращающий opaque object.
Этот handle принадлежит серверу: не является полем HTTP-контракта, native settings
snapshot или сериализуемой конфигурации. Содержимое и принадлежность проверяет адаптер.

Внутренние типы предусматривают `preparedRuntime` в `ExecutorRunInput`, третий аргумент
`sessionBinding.securityProfile` и дополнительный аргумент native settings context.
Общие capability/context/launch передают тот же объект без копирования. Старые адаптеры
без hook продолжают получать прежние аргументы; их поведение не меняется.

Общий чат вызывает hook один раз до подготовки native settings и до CAS binding,
включая ход без overrides. Один объект передаётся settings context, securityProfile и
run. Поле с таким именем из HTTP body не используется; handle не включается в историю,
SSE или ответ. Ошибка подготовки даёт `executor_unavailable` до изменения binding.
Адаптер проверяет чужие handles; null и массив отклоняются общей границей подготовки.

DeepSeek и GLM хранят descriptors в отдельных WeakMap общего scope-factory по пустому
замороженному handle. Handles разных провайдеров несовместимы. Ключ выбора
проверяет также cache, override и пути generation; handle от другой подготовки или
конфигурации отвергается с `deepseek_runtime_changed` или `glm_runtime_changed`.
Native context закрепляет тот же
descriptor, а snapshot с другой runtimeIdentity не принимается при запуске.

Перед эффектами запуска DeepSeek сверяет файл бинарника с закреплёнными signature/SHA и
packageId. Смена выбранного ELF или symlink после securityProfile/CAS останавливает текущую
попытку до web-процесса и prompt, без автоматического повтора и изменения прежней сессии.
Это проверено на настоящей паре ELF с разными packageId при пустых overrides и после
settings discovery. Изменение bytes при сохранённой публичной identity также даёт отказ.
