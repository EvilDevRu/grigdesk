# Доступность моделей в чате и настройках

В каталоге выбора модели чата видны только доступные исполнители: `available === true`
и `chatEnabled !== false`. Недоступный исполнитель не получает вкладку и варианты
в списке, «Все» и поиске. Сохранённая модель разговора при этом не меняется сама;
подробности — в [контракте фильтра](model-picker-availability.md).

Карточка арбитра (`views/settings/pages/PreferencesPage.vue`) и параметры плагина
(`views/settings/pages/PluginPage.vue`) сохраняют прежний контракт: недоступность
помечает группу, но не запрещает выбор модели для будущей настройки.

Сервер разрешает сохранённую модель по полному каталогу `modelsRegistry`, а не по
отфильтрованному `providerRegistry`. Каталог не стирается при пустом ответе CLI:
`mergeCatalog` сохраняет прежние модели. Фильтр чата управляет только представлением;
при запуске сервер и исполнитель по-прежнему сообщают фактическую причину отказа.

Проверки: `tests/web/chat-model-availability.component.test.js`,
`tests/web/ui-select.browser.test.js`, `tests/web/settings-arbiter.component.test.js`,
`tests/web/settings-plugin-model.component.test.js`.
