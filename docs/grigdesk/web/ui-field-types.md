# Типы полей через публичную границу UI

Типы UI-kit, включая `UiFieldHandle`, доступны product-коду через
`web/src/ui.ts`. Импорт `type` подчиняется той же границе, что и импорт
компонента: прямой путь к `web/src/types/uiFields.ts` обходит фасад.

`BoardView.vue` и `views/chat/ChatList.vue` используют публичный реэкспорт
`UiFieldHandle`. Он сохраняет исходный контракт `el`, `focus` и необязательный
`select`; импорт типа не добавляет зависимости при выполнении.

Границу проверяют `npm --prefix web run check:ui` и
`tests/web/ui-dependency-boundary.test.js`; доступность типа проверяет
`npm --prefix web run typecheck`.
