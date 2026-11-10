# Плагины

Читай при изменении API плагинов, установки пакетов и встроенных инструментов.

SSH, просмотр документов, «Код», стенды и песочницы, презентации.

Читай перед правкой: `server/src/modules/ssh`, `server/src/lib/ssh`, `server/src/lib/documents`, `server/src/modules/code`, `server/src/lib/sandboxes`, `server/src/lib/showcase`.

## Контракты продукта

Документация Studio3D поставляется самим плагином в `docs/README.md`. Ключи и протокол
Tripo остаются в ядре; библиотека, заказы, просмотр и экспорт принадлежат плагину.

- [Манифест v1: декларации, активация, иконки, галерея и несовместимость](manifest-v1.md)
- [Контракт автора пользовательского плагина: манифест, панель, серверное ядро, TS, установка и замена](author-contract.md)
- [Чувствительные файлы предпросмотра: объявленный код и метаданные пакета](plugin-sensitive-files.md)
- [Плагины: слоты, размещения и область](../guide/plugins.md)
- [Плагин «Код»](../guide/code.md)
- [Раздел «Песочницы»](../guide/sandboxes.md)
- [Раздел «Презентации»](../guide/showcase.md)
- [Плагин «Докер»](../guide/docker.md)

## Устройство

- [Ветка единственного стенда: выбор, команды запуска, возврат на dev, журнал и защита агентов](code-branch-runtime.md)
- [Официальные пакеты: скрытие общих предупреждений при сохранении проверок и подтверждения](official-install-notices.md)
- [Git в фоне: fast-forward, fetch, завершение после закрытия панели и свежий tracking](code-git-notifications.md)
- [Read-only diff: исходные координаты, Worker, отложенный resize, настройки и навигация блоков](code-diff-view.md)
- [Проверка Git-изменений: fingerprints, частичный индекс, scoped actions и ignore](code-review.md)
- [Ресурсы фонового плагина во всплывашке исполнителя: JSON, переводы и отмена](server-provider-resources.md)
- [Включение, обновление и откат без перезапуска: собственный router, onClose и поколения ESM](plugin-hot-runtime.md)
- [Резервное обновление при следующем запуске: подтверждение, отмена и проверка до import](plugin-update-on-restart.md)
- [Общий git-установщик драйверов: отдельная политика пакета, цель, журнал и HTTP](driver-installer-policy.md)
- [Устанавливаемые драйверы БД: Git, чувствительные изменения manifest/entry, SPI и recovery](db-engine-install.md)
- [Снос ручного стенда без журнала: явный выбор профиля и проверка владельца](manual-sandbox-removal.md)
- [Пакет типов: переносимые декларации, подключение, совместимость и пример TS/Vue](plugin-types.md)
- [Серверные сервисы core: проекты, единая среда с защищёнными путями, песочницы и model-only](plugin-core-runtime.md)
- [Сборка деклараций: файловые ссылки и видимая пометка служебных экспортов](plugin-types-declarations.md)
- [Модульные панели v1: фасады Vue/UI, контекст, ошибки и сборка](plugin-ui-modules.md)
- [Сервисы модуля v1: binary API, настройки, события, уведомления, intents и холодная загрузка чата](plugin-module-services.md)
- [Серверные оповещения: generation, snapshot, dedup/импорт прежнего seen, темы и RU/EN](plugin-notifications.md)
- [Отдельный background entry: boot без панели, готовность, retry и очистка эпохи](plugin-background.md)
- [Отзыв модуля после выключения в другом окне: каталог через общий SSE](plugin-module-catalog-sync.md)
- [Открытая модульная панель: ввод и подписки после восстановления связи оболочки](plugin-panel-reconnect.md)
- [Каталог сайта, происхождение и единый раздел плагинов](plugin-marketplace.md)
- [Единый каталог v1: история версий и изображения detail](catalog-schema.md)
- [Автоматический выбор сайта каталога и согласование снимков при отказе](catalog-failover.md)
- [Локальный резерв каталога: последний хост, каналы и ограничения HTTP](catalog-loopback-fallback.md)
- [Каталог и протокол Tripo: фасад, владельцы полей, цен, запросов и ответов](tripo-module-boundaries.md)
- [Границы установки: публикация, runtime lease и общие значения DTO](plugin-install-module-boundaries.md)
- [Установка из git: версии, проверка пакета, обновление, откат и восстановление](user-plugin-install.md)
- [Удаление пользовательского пакета: несовместимые пакеты, identity recovery и сохранение данных](user-plugin-removal.md)
- [Установка v1: проверка модуля, доверие, обновление и единый каталог](plugin-module-install.md)
- [Installer boot: пути, VERSION, SYSTEM, recovery до import и close](plugin-install-boot.md)
- [Runtime lease, drain, объявленные входы v1, поколения модуля и строгий HTTP установки](plugin-install-runtime.md)
- [Сервис подготовки: admission, owned reads, managed update и snapshot rollback](user-plugin-install-service.md)
- [Замена папок: durable intent, identity resolver, cleanup и process-crash barriers](user-plugin-apply-recovery.md)
- [Подготовка npm: реальный offline fixture, изоляция config и durable state](user-plugin-npm-state.md)
- [Пакет до npm: безопасные пути, manifest, lock graph и digest результата](user-plugin-package-validation.md)
- [Git-источник: точный тег, tree до checkout, закрытая конфигурация и NUL diff](user-plugin-git-source.md)
- [Команды подготовки: durable ACK, группы потомков и предел рабочего каталога](plugin-command-supervisor.md)
- [Плагины GrigDesk](plugin-architecture.md)
- [Иконки плагинов: файл манифеста, резервный знак и единые размеры картинок и SVG](plugin-icons.md)
- [Runtime пользовательского плагина: загрузка, авторизация и границы долгих заданий](user-plugin-runtime.md)
- [Серверный набор ядра: возможности без ключей, синхронная identity flock, события и допуск](server-core-api.md)
- [Ошибки проверки настроек и серверных входов: собственные коды, HTTP 409 и точная причина](plugin-change-errors.md)
- [Документация пользовательского плагина: постоянное место docs/README.md, подсказка хода и право чтения](plugin-docs.md)
- [Источник рассказа ролика: один снимок, строгий git и выбор как вход сборки](showcase-story-source.md)
- [Настройки роликов: начало работы, состояния компонентов и альтернативные голоса](showcase-settings.md)
- [Чтение источника ролика: ссылки, внешние Git-обработчики и границы текста](showcase-source-reading.md)
- [Сохранение источника и начало сборки: общий допуск и позднее подтверждение](showcase-source-admission.md)
- [Просмотр документов](documents.md)
- [Tripo API v3: каталог, uploads, пулы, ошибки, прайс и грабли форматов](tripo-api.md)
- [SSH-плагин: общие сессии всех чатов, однозначный выбор и подтверждения](ssh.md)

## Грабли

- [Базы: сохранение дат, непрерывный срез результата, ошибки, отмена и повреждённый аудит](db-human-query-pitfalls.md)
- [npm ci: ignore-scripts не закрывает запуск через project .npmrc](npm-install-config.md)
- [Параллельные записи журнала песочницы теряли общий временный файл на rename](sandbox-journal-concurrency.md)
- [«Сборка остановлена. locator.waitFor: Timeout…» у «Собрать ролик» = продолжение ждало каркас экрана, с которого предыдущая сцена ушла; страницы фичи не было в карте — теперь экраны находятся сами](showcase-scene-navigation.md)
- [Адрес стенда: прямой порт текущего хоста](sandbox-host-resolution.md)
- [Хост профиля в ссылках на стенд и локальная авторизация](sandbox-profile-host.md)
- [Выполненный прогон shared-профиля не уходил с экрана: закрывать было нечем](shared-run-dismissal.md)
- [Ролик презентации из одинаковых кадров = карта экранов профиля не знала фичи, а отказ записи спрятала цепочка](showcase-screen-discovery.md)
- [Чтение git из GrigDesk: diff HEAD — не вся правда, а не-ASCII путь приезжает байтами](git-diff-and-path-encoding.md)
- [«Код» замерзает на новом репозитории = тысячи файлов в индексе, все каталоги раскрыты](code-large-change-list.md)
- [SSH-плагин закрывается на каждой границе](ssh-access-boundaries.md)
- [Проверка изменений: ровные панели, компактные меню, просмотрено, замечания и выбор](code-review-ui.md)
- [Плагин «Код» — подробный контракт](code-interface.md)
- [Плагин «Докер» — подробный контракт](docker-contract.md)
- [Плагины: слоты, размещения и область — подробный контракт](placements.md)
- [Раздел «Песочницы» — подробный контракт](sandbox-operations.md)
- [Раздел «Презентации»: контракт, запись и проверка сжатых клипов по кадрам](showcase-reference.md)
