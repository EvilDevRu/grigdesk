# Плагины

SSH, просмотр документов, «Код», стенды и песочницы, презентации.

Читай перед правкой: `server/src/modules/ssh`, `server/src/lib/ssh`, `server/src/lib/documents`, `server/src/modules/code`, `server/src/lib/sandboxes`, `server/src/lib/showcase`.

## Контракты продукта

- [Плагины: слоты, размещения и область](../guide/plugins.md)
- [Плагин «Код»](../guide/code.md)
- [Раздел «Песочницы»](../guide/sandboxes.md)
- [Раздел «Презентации»](../guide/showcase.md)
- [Плагин «Докер»](../guide/docker.md)

## Устройство

- [Плагины кокпита](plugin-architecture.md)
- [Иконки пользовательских плагинов: выбор в манифесте и общая карта](plugin-icons.md)
- [Runtime пользовательского плагина: загрузка, авторизация и границы долгих заданий](user-plugin-runtime.md)
- [Источник рассказа ролика: один снимок, строгий git и выбор как вход сборки](showcase-story-source.md)
- [Чтение источника ролика: ссылки, внешние Git-обработчики и границы текста](showcase-source-reading.md)
- [Сохранение источника и начало сборки: общий допуск и позднее подтверждение](showcase-source-admission.md)
- [Просмотр документов](documents.md)
- [SSH-плагин](ssh.md)

## Грабли

- [Параллельные записи журнала песочницы теряли общий временный файл на rename](sandbox-journal-concurrency.md)
- [«Сборка остановлена. locator.waitFor: Timeout…» у «Собрать ролик» = продолжение ждало каркас экрана, с которого предыдущая сцена ушла; страницы фичи не было в карте — теперь экраны находятся сами](showcase-scene-navigation.md)
- [Адрес стенда: прямой порт текущего хоста](sandbox-host-resolution.md)
- [Выполненный прогон shared-профиля не уходил с экрана: закрывать было нечем](shared-run-dismissal.md)
- [Ролик презентации из одинаковых кадров = карта экранов профиля не знала фичи, а отказ записи спрятала цепочка](showcase-screen-discovery.md)
- [Чтение git из кокпита: diff HEAD — не вся правда, а не-ASCII путь приезжает байтами](git-diff-and-path-encoding.md)
- [«Код» замерзает на новом репозитории = тысячи файлов в индексе, все каталоги раскрыты](code-large-change-list.md)
- [SSH-плагин закрывается на каждой границе](ssh-access-boundaries.md)
