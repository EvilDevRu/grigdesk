# Карта экранов для визуальной сверки

Источник маршрутов — `web/src/router.js`: 24 маршрута с компонентами и редирект
`/` → `/board`. Это карта точек входа; вкладки, модальные окна и состояние
выбранного объекта не становятся отдельными маршрутами автоматически.

## Маршруты

Все файлы в таблице находятся в `web/src/views/`.

| Маршрут | Компонент |
| --- | --- |
| `/board` | `BoardView.vue` |
| `/pipeline` | `PipelineView.vue` |
| `/chats` | `ChatsView.vue` |
| `/agents` | `AgentsView.vue` |
| `/routes` | `RoutesView.vue` |
| `/projects/:id?` | `ProjectsView.vue` |
| `/tools` | `ToolsView.vue` |
| `/code` | `CodeView.vue` |
| `/shelf` | `ShelfView.vue` |
| `/terminal` | `TerminalView.vue` |
| `/ssh` | `SshView.vue` |
| `/db` | `DbView.vue` |
| `/docker` | `DockerView.vue` |
| `/3d` | `Studio3dView.vue` |
| `/sandboxes` | `SandboxesView.vue` |
| `/showcase/:id?` | `ShowcaseView.vue` |
| `/video` | `VideoView.vue` |
| `/inbox` | `InboxView.vue` |
| `/github` | `GitHubView.vue` |
| `/telegram` | `TelegramView.vue` |
| `/documents` | `DocumentsView.vue` |
| `/diff` | `DiffView.vue` |
| `/settings` | `SettingsView.vue` |
| `/ext/:id` | `ExtPluginView.vue` |

Панели инструментов монтирует `shared/layout/ToolHost.vue`; route-adapter
не является второй копией панели. Внешний плагин использует
`views/ext/PluginFramePanel.vue`: его содержимое внутри iframe принадлежит
самому плагину и не определяется исходниками встроенного UI.

## Дополнительные поверхности

`SettingsView.vue` содержит восемь вкладок: `app`, `speech`, `b24`, `providers`,
`runs`, `plugins`, `server`, `access`. Отдельное окно настроек использует
`shared/layout/SettingsWindowShell.vue`; обычный маршрут и это окно имеют
разные оболочки. Контракт определения окна — `shared/desktop/desktopWindowContract.ts`
от корня репозитория.

В `App.vue` также находятся `NoAccessView`, общие hosts диалогов, подсказок
и тостов, `TaskModal`, `DiffModal`, `DocumentModal`. Проверка одних маршрутов
не покрывает эти поверхности, раскрытия топбара, формы создания и редакторы
выбранных объектов.

## Условия воспроизводимой сверки

Для снимка нужны настоящий Vue-компонент, состояние его стора и корректный
ответ API. Пустой объект вместо закрытого DTO вызывает сообщение об ошибке
контракта и не является готовым рабочим состоянием экрана.

Сценарии с hash history следует начинать с нового документа: смена только
`#/route` сохраняет Pinia, открытые глобальные диалоги и другие состояния.
При сравнении независимых экранов это может незаметно перенести модальное
окно предыдущего сценария на следующий снимок.

Повторное использование вложенных компонентов должно сохранять значения
каждого экземпляра. Одинаковое оформление не означает одинаковые placeholder,
выбранную опцию или подпись. При разложении DOM в библиотеку нужна отдельная
проверка текстов после развёртывания вложенных экземпляров.

Общие controls и их стили перечислены в [инвентаризации UI](ui-inventory.md).
Состояние конкретной внешней доски и ограничения аккаунта хранятся в локальной
документации машины.
