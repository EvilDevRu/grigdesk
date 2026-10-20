# Scoped-стили страниц настроек

Страницы `views/settings/pages/` владеют только своей раскладкой. Scoped CSS оболочки
не распространяется на дочерние SFC и Teleport-поверхности. Controls, диалоги и их
оформление приходят из `web/src/ui.ts`; локальные button/input skins не создаются.

`MobileAccess.vue` и `ProviderMcpStatus.vue` сохраняют собственную раскладку карточек
и списков. Общие параметры геометрии наследуются через CSS-токены, включая вложенные
диалоги в body. Проверки форм выполняются на настоящих SFC с общим CSS.

Строки полей и смысловые группы объединены в `SettingsField` и `SettingsSection`.
Контексты `data-ui-settings-*` в `styles/components/patterns.css` оформляют дерево,
результаты поиска и раскладку `UiField`. Устройство всех страниц описано в
[оформлении настроек](settings-design.md).
