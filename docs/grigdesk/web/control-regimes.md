# Режимы controls: обычный, рабочий, сенсорный и диалоги

Вид общих полей и кнопок задают токены `web/src/styles/tokens.css`. Размеры одного
`UiInput` зависят от пометки ближайшего контейнера, фон полей общий во всех слоях.

| Пометка контейнера | Высота | Фон поля | Скругление | Текст поля |
| --- | ---: | --- | ---: | ---: |
| нет пометки | 36 | `--surface-2` | 9 | 14 |
| `data-ui-workspace` | 32 | `--surface-2` | 4 | 13 |
| `data-ui-touch` | 44 | `--surface-2` | от окружения | от окружения |

Рабочий режим ставят Проекты, Маршруты, Песочницы, окно Настроек, страница плагинов и
[Доска](../b24/board-control-styles.md). Конвейер, список чатов и Входящие остаются без пометки.

## Диалоги

`UiDialog` выводится через `Teleport` в `body` и теряет пометки родителя. Поэтому
диалог, открытый из рабочего раздела, получает обычный вид, если пометка не стоит на его
собственном содержимом или surface. Её имеют окно Настроек, [окно узла конвейера](../pipeline/node-dialog-controls.md),
[создание задачи](new-task-dialog.md), [просмотр задачи](task-detail-design.md)
и [выбор рабочей папки чата](chat-workdir-controls.md), а также
[установщик плагинов и драйверов](plugin-install-design.md).
Отдельные диалоги
(привязка устройства, сохранение 3D, prompt
общего хоста и другие) показывают поля по 36 px на общей поверхности `--surface-2`.

`--field-background` задаёт `--surface-2` всем полям; readonly использует
`--field-background-readonly` (`--surface`). Teleport не меняет эти цвета.
[Общий фон полей](field-background-sources.md), включая [поиск селекта](select-search-surface.md),
не зависит от `--control-background` кнопок и переключателей. Высота и сенсорный режим
по-прежнему зависят от токенов окружения меню.

## Ручной сенсорный режим

`data-ui-touch` вручную стоит в `MobileAccess.vue`, `ServerAccessPanel.vue`,
`PhoneConnectDialog.vue` и `MobilePairingDialog.vue`; `confirmDialog` включает его опцией
`touchTargets`. Пометка действует и на компьютере с мышью: поля и кнопки этих мест
получают 44 px. На сенсорном экране корень получает тот же атрибут автоматически —
[сенсорный размер](touch-control-size.md).

## Правила без потребителя

Селекторы `[data-context='settings-field']` в `styles/components/fields.css` не находят
элементов: `settings-field` — класс обёртки `SettingsField.vue`, а не `data-context`
поля. Их кегль 14 px на Настройки не действует. Без найденного потребителя
также `settings-command`, `settings-compact-action`, `settings-provider-disclosure`,
`settings-textarea` и `workspace-instruction`.

Живой замер всех маршрутов и страниц настроек — [через посредника с CLI-токеном](../testing/live-ui-cli-proxy.md).
