# Qwen Code: границы подключения и внешние источники

Проверено по коду GrigDesk и официальной документации Qwen 2026-10-18.
Этот документ фиксирует точки интеграции и сведения upstream, а не заявляет готовность
исполнителя или проверку установленного CLI живым model call.

## Две точки подключения

Чат обнаруживает адаптеры в `server/src/lib/executors/` через `getProviderAdapters`.
Наличие метода `run` и универсального типа открывает чатовый runtime.
Карточка setup-only без `run` сама по себе не предоставляет поддержку чатов.

Конвейер отдельно обнаруживает shell-модули в `engine/lib/runners/`.
Каталог сервера `runnersCatalog.ts` не выводит поддержку Factory из наличия чатового
адаптера. Новый исполнитель требует обе точки подключения и проверки общего запуска.
Подробнее — [границы выбора раннера](../pipeline/runner-selection-boundaries.md).

В `factoryRouteCli.ts` запуск через systemd передаёт ключи отдельным `EnvironmentFile`,
а fallback без systemd наследует окружение процесса. Проверка запуска из терминала
не доказывает, что доступ доедет до transient service.

## Что сообщает upstream

Официальное описание различает headless CLI, ACP по stdio и отдельный daemon.
Совместимость одного транспорта не доказывает совместимость другого.
[Способы интеграции Qwen Code](https://qwenlm.github.io/qwen-code-docs/en/developers/rest-api-integration/).

Headless-документация описывает структурированный вывод и возобновление по конкретной
сессии. Конкретные события, отмена, permissions и учёт расхода требуют проверки выбранной
версии и транспорта.
[Headless Mode](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/).

Документация авторизации помечает прежний Qwen OAuth как прекращённый с 2026-04-15.
Она описывает доступ через API-ключи и конфигурацию провайдера; доступность конкретного
аккаунта нельзя выводить из наличия ключа или старого OAuth-файла.
[Authentication](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/).

Каталог `modelProviders` задаёт настроенные модели и их параметры. Эти записи сами по
себе не подтверждают успешную авторизацию и доступ аккаунта к выбранной модели.
[Model Providers](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/).

В дереве также есть Qwen3-TTS для озвучки презентаций. Это отдельная интеграция,
не runtime универсального coding-исполнителя.
