# Notices зависимостей GLM

Проверка лицензий охватывает все 190 exact-версий closure pi-ai 0.85.1.
Если npm-пакет не содержит license/notice, сборщик использует только заранее
подготовленный supplement для точной пары имени и версии и соответствующей declaration.
Соседняя версия не получает разрешение автоматически. Отсутствующий notice остаётся ошибкой.

Источники и SHA-256 текстов находятся в `tools/deepseek-build/licenses/sources.json`.
Там же записаны exact-версии и integrity npm-пакетов. Тексты сохранены в этой папке;
сборка generation не скачивает их. Перед копированием writer проверяет SHA-256.
Все supplements входят в fingerprint входов сборки, их копии — в payload generation.

- AWS: Apache-2.0 из [закреплённого commit SDK](https://github.com/aws/aws-sdk-js-v3/blob/313813d9e1f25eb6896cf2880977f01ee7fb2556/LICENSE).
  Текст побайтно совпадает с LICENSE установленного `@aws-sdk/core`.
  Разрешение ограничено credential-provider-http 3.972.48,
  credential-provider-login 3.972.52 и nested-clients 3.997.20.
- pi-ai и pi-telemetry 0.85.1: MIT из [commit публикации](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/LICENSE),
  подтверждённого npm metadata обеих библиотек.
- entities 2.2.0: MIT из [commit публикации](https://github.com/nodable/val-parsers/blob/1a2c08a483b5b6428f1b3d01974875c97f3b3953/LICENSE).
- standardwebhooks 1.1.1: MIT из [лицензии libraries](https://github.com/standard-webhooks/standard-webhooks/blob/b4d2c14fc5b4ccff3ff271e3b087dff812254c59/libraries/LICENSE).
  Корневой Apache-2.0 этого репозитория не соответствует declaration npm-библиотеки.
- xml-naming 0.1.0: MIT из [первого commit](https://github.com/NaturalIntelligence/xml-naming/blob/c0afc395948730bed124859d7fc7cccabe0aac8a/LICENSE),
  в котором package.json содержит ту же версию.

В data-uri-to-buffer 4.0.1 полный MIT notice уже находится в README.
Writer проверяет declaration, copyright, разрешающий текст и disclaimer, затем сохраняет README целиком.

Closure включает type dependencies. Их notices собираются до удаления корневого
`node_modules/@types` из payload; исполняемые compiler dependencies по-прежнему удаляются.
Unit-стенд проверяет notices всех 190 версий, fingerprint supplements и отказ для соседней версии.
Настоящая generation с этим составом ещё должна пройти compiled-проверки.
