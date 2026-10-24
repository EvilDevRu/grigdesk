# Одна кнопка очистки поиска

`UiSearchInput` содержит `UiInput` с `type="search"` и собственную кнопку очистки
с доступным именем. В `web/src/styles/components/fields.css` браузерный
`::-webkit-search-cancel-button` скрыт через `appearance: none` внутри `.ui-search-input`,
чтобы Chromium и WebKit не показывали второй крестик.

Отдельный `UiInput` с `type="search"` сохраняет встроенную кнопку браузера.
Кнопка `UiSearchInput` очищает модель и после обновления DOM возвращает фокус полю.
