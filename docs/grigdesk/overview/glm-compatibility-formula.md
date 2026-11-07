# Общая формула допуска GLM

`shared/node/glmCompatibility.ts` вычисляет один SHA256 для сервера и установщика ELF.
Входы прежние: upstream commit, patches, composition, runtime dependency lock, версия и
integrity pi-ai, hash исходников плагина, ревизии профиля и политики, адрес API режима.
Объект сериализуется общей `canonicalJson`; порядок массива patches сохраняется.

Путь, платформа, ABI Node, версия бинарника, buildId и packageId не входят в compatibility.
Поэтому перенос формулы в общий модуль не создаёт новый допуск и не меняет память GLM.
Серверная `glmCompatibilityIdentity` сохраняет прежнее имя и ревизии по умолчанию.
Общий модуль требует ревизии явно и не читает файлы, окружение или список admission.

Установщик вычисляет compatibility по metadata проверяемой копии и требованиям установленного
host. Он требует совпадающую запись допуска API, а не только наличие плагина или строку режима.
Проверки формулы и всех её входов: `tests/server/glm-contract.test.js`; проверка admission
и целостности ELF при установке: `tests/deepseek/install.test.mts`.
