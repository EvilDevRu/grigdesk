# Плагины

SSH, просмотр документов, «Код», стенды и песочницы, презентации.

Читай перед правкой: `server/src/modules/ssh`, `server/src/lib/ssh`, `server/src/lib/documents`, `server/src/modules/code`, `server/src/lib/sandboxes`, `server/src/lib/showcase`.

## Контракты продукта

- [Раздел «3D»: создание, деньги, библиотека, scoped viewer и восстановление](../guide/studio3d.md)

- [Плагины: слоты, размещения и область](../guide/plugins.md)
- [Плагин «Код»](../guide/code.md)
- [Раздел «Песочницы»](../guide/sandboxes.md)
- [Раздел «Презентации»](../guide/showcase.md)
- [Плагин «Докер»](../guide/docker.md)

## Устройство

- [Каталог и протокол Tripo: фасад, владельцы полей, цен, запросов и ответов](tripo-module-boundaries.md)

- [Заказы 3D: резервы, скачивание, публикация файлов и пачки](studio3d-job-boundaries.md)

- [Границы установки: публикация, runtime lease и общие значения DTO](plugin-install-module-boundaries.md)

- [Установка из git: версии, проверка пакета, обновление, откат и восстановление](user-plugin-install.md)

- [Installer boot: пути, VERSION, SYSTEM, recovery до import и close](plugin-install-boot.md)

- [Runtime lease, drain потоков, user dataDir и строгий HTTP установки](plugin-install-runtime.md)

- [Сервис подготовки: admission, owned reads, managed update и snapshot rollback](user-plugin-install-service.md)

- [Замена папок: durable intent, identity resolver, cleanup и process-crash barriers](user-plugin-apply-recovery.md)

- [Подготовка npm: реальный offline fixture, изоляция config и durable state](user-plugin-npm-state.md)

- [Пакет до npm: безопасные пути, manifest, lock graph и digest результата](user-plugin-package-validation.md)

- [Git-источник: точный тег, tree до checkout, закрытая конфигурация и NUL diff](user-plugin-git-source.md)
- [Команды подготовки: durable ACK, группы потомков и предел рабочего каталога](plugin-command-supervisor.md)

- [Плагины GrigDesk](plugin-architecture.md)
- [Иконки пользовательских плагинов: выбор в манифесте и общая карта](plugin-icons.md)
- [Runtime пользовательского плагина: загрузка, авторизация и границы долгих заданий](user-plugin-runtime.md)
- [Документация пользовательского плагина: постоянное место docs/README.md, подсказка хода и право чтения](plugin-docs.md)
- [Источник рассказа ролика: один снимок, строгий git и выбор как вход сборки](showcase-story-source.md)
- [Чтение источника ролика: ссылки, внешние Git-обработчики и границы текста](showcase-source-reading.md)
- [Сохранение источника и начало сборки: общий допуск и позднее подтверждение](showcase-source-admission.md)
- [Просмотр документов](documents.md)
- [Ядро 3D: DTO, снимок аккаунта, целостность скачивания и ограниченный GLB анализ](studio3d-core.md)
- [Библиотека 3D: расположение и отделение от обычного дерева](studio3d-library.md)
- [Файловые границы 3D: дескрипторы, подмена предка, независимый copy и overwrite по SHA](studio3d-file-boundaries.md)
- [Поиск 3D и сводки: фильтры, actual/estimated и независимые единицы расходов](studio3d-search.md)
- [Исполнители 3D: capability адаптера, предложения и происхождение native входов](studio3d-providers.md)
- [Tripo API v3: каталог, uploads, пулы, ошибки, прайс и грабли форматов](tripo-api.md)
- [Журнал заказов 3D: durable UUID, исходный fingerprint и конкурентные записи](studio3d-intents.md)
- [Выполнение 3D: последний допуск POST, неизвестные исходы, пачки и расходы](studio3d-jobs.md)
- [Восстановление 3D: проекции без лишних записей, сроки, форматы и пределы](studio3d-recovery-and-limits.md)
- [Импорт 3D: ограниченный scan, DAG, история и tombstones](studio3d-importer.md)
- [API 3D: закрытые схемы, transactional lifecycle, uploads и scoped viewer](studio3d-server.md)
- [SSH-плагин](ssh.md)

## Грабли

- [npm ci: ignore-scripts не закрывает запуск через project .npmrc](npm-install-config.md)

- [Параллельные записи журнала песочницы теряли общий временный файл на rename](sandbox-journal-concurrency.md)
- [«Сборка остановлена. locator.waitFor: Timeout…» у «Собрать ролик» = продолжение ждало каркас экрана, с которого предыдущая сцена ушла; страницы фичи не было в карте — теперь экраны находятся сами](showcase-scene-navigation.md)
- [Адрес стенда: прямой порт текущего хоста](sandbox-host-resolution.md)
- [Выполненный прогон shared-профиля не уходил с экрана: закрывать было нечем](shared-run-dismissal.md)
- [Ролик презентации из одинаковых кадров = карта экранов профиля не знала фичи, а отказ записи спрятала цепочка](showcase-screen-discovery.md)
- [Чтение git из GrigDesk: diff HEAD — не вся правда, а не-ASCII путь приезжает байтами](git-diff-and-path-encoding.md)
- [«Код» замерзает на новом репозитории = тысячи файлов в индексе, все каталоги раскрыты](code-large-change-list.md)
- [SSH-плагин закрывается на каждой границе](ssh-access-boundaries.md)
