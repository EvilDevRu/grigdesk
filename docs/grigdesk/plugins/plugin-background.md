# Отдельный фоновый вход оконного пакета

Optional `entrypoints.web.background` — относительный JS/mjs внутри того же web.dir.
Это отдельный ESM с named start(context), без default Vue-компонента.
Он не импортирует panel entry и не подключает CSS; JSON локали и общий Vue допустимы.
Пакеты без поля сохраняют прежний запуск UI start по спросу.

Scanner/installer используют проверки entry: собственный обычный файл, допустимый
путь/расширение, без symlink. DTO получает URL того же generation; старый URL после
off/on/update не отдаёт новую версию. Sensitive preview включает весь web.dir.

Главное/page окно создаёт coordinator после auth и принятого свежего каталога.
Жизнь замкнута на owner/pluginId/runtimeGeneration/access epoch. Enabled compatible
пакет стартует и на странице чатов; surface-окно фон не запускает. Identity Vue/UI
проверяется общим loader helper, новый экземпляр библиотек не создаётся.

PluginBackgroundContext содержит base api/settings/locale/t, signal и alerts.
Alerts принадлежат plugin-background:<id>, независимо от panelActive. Optional
context.backgroundReady панели ждёт тот же start. Последний release панели фон не закрывает.

Off/removal/update/owner/logout/offline сразу abort контекст. Ожидающая панель
получает отказ без ожидания async start; cleanup, в том числе поздний, выполняется
один раз. Старый cleanup не отзывает новую запись или её оповещения.
Ошибка видна общим alert с повтором; бесконечного retry нет. Явный backgroundReady
после отказа повторяет попытку. Reconnect создаёт новую эпоху после свежего каталога.
Identity/import ограничены сроком; автор проверяет signal после await и перед мутациями.
Готовность start означает доступность сервиса, а не завершение долгих операций.

Несколько входов пакета используют одну ES multi-entry сборку с общим service chunk.
Независимые сборки с дублированным singleton совместное владение не обеспечивают.
Host не хранит продуктовые pending или библиотеку.

Проверки: plugin-background-module, plugin-module-background, v1 manifest/package,
installer sensitive preview и hot runtime. Фикстуры не являются приёмкой установленного комплекта.
