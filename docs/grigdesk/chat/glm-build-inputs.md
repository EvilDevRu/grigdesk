# Входы сборки модельного плагина GLM

Состав host-overlay включает `@deepseek-ai/dsh-llm-pi-ai`. Композиция исключает
его строку из base YAML: наличие пакета в сборочном замыкании само по себе
не монтирует плагин в процесс DeepSeek. Ревизия композиции —
`grigdesk-host-web-acp-v4`. В runtime metadata к ней добавляется SHA256 входов сборки:
изменение native gate, протокола или preset меняет compatibility без ручного переноса старого допуска.
Проверка обхода manifests и исключения строки
выполняется на малом синтетическом дереве исходников.

Функция `llmPiAiExternalDependencies` выводит внешние зависимости из importer
`packages/llm/llm-pi-ai` в upstream pnpm lock. Обход учитывает dependencies
и optionalDependencies каждого snapshot, сохраняет его peer-контекст
и возвращает уникальные пары имени и exact-версии с integrity.
Отсутствующие snapshots, диапазоны вместо exact-версий, отсутствующая integrity
и флаги нативной сборки отвергаются.

Для закреплённого pi-ai 0.85.1 ветка содержит 190 версий пакетов с integrity.
Подготовка сборочного manifest добавляет 183 exact-записи. Уже существующие
зависимости сохраняются; конфликтующие версии получают npm aliases по тому
же правилу, которое использует сборщик Harness.

Установка exact-зависимостей завершена. Штатный sync того же commit с полным
[workspace-замыканием](glm-workspace-source-closure.md) добавил исходники `llm-pi-ai` и
`credentials/authorization` (50 файлов, изменённых и удалённых нет); snapshot опубликован
штатным publish вместе с compiled-parity gate, `deepseek:verify` зелёный.

Сборщик проверяет notices всего установленного дерева. В закреплённой ветке
`@aws-sdk/credential-provider-http@3.972.48` объявляет `Apache-2.0`, но npm-пакет
не содержит license/notice. Проверенные [offline supplements](glm-license-inventory.md)
закрывают отсутствие текста у точных версий без ослабления проверки.
Unit-стенд и настоящая generation подтвердили notices всех 190 версий.

AST-сканирование сборки охватывает host TypeScript и весь JS dist pi-ai.
Четыре вычисляемых import pi-ai зарегистрированы точными выражениями с причинами.
Неизвестный import внешней библиотеки запрещает сборку, как и неизвестный host import.

В редакторе нативных настроек DeepSeek весь namespace `llm-pi-ai` принадлежит
GrigDesk. Все его описанные поля, включая неизвестные заранее, доступны только для чтения.
Проверка записи возвращает `readonly_field`; соседние namespaces сохраняют свои права.
Контракт подтверждён через settings description, каталог и валидатор записи на стенде.

Текущий production runtime не переключался. Изменение серверного ownership требует
ручного перезапуска службы, чтобы работающий сервер начал применять этот контракт.
