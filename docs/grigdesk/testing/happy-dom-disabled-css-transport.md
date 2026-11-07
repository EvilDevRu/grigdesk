# Happy-dom: отключённая загрузка CSS посылает преждевременный error

В happy-dom 18.0.1 настройка `disableCSSFileLoading=true` не оставляет внешний
stylesheet в ожидании. `HTMLLinkElement.#loadStyleSheet()` синхронно отправляет
`error` при подключении `link` к документу. Если включить
`handleDisabledFileLoadingAsSuccess`, вместо него столь же рано приходит `load`.
Оба исхода происходят до ответа управляемого HTTP-транспорта фикстуры.

Это обнаружилось при проверке установленного модуля: фон успешно восстанавливал
намерение, JS и CSS приходили по настоящим адресам, но общий `PluginModulePanel`
показывал отказ загрузки. Его lease создавался, затем преждевременный CSS error
запускал cleanup. Ошибка была в транспорте happy-dom, а не в байтах модуля.

[Фикстура установленной панели](../../../tests/web/helpers/studio3dInstalledBrowser.js)
реализует `appendWithStylePort()` и `receiveStyle()`:

1. При собственном `append` или `appendChild` временный capture-listener подавляет
   только синхронный error отключённого native CSS-загрузчика.
2. Сразу после native append этот listener снимается. Нельзя оставлять его на весь
   срок загрузки: тогда настоящий HTTP-отказ ошибочно выглядел бы успешным.
3. Управляемый транспорт читает CSS через настоящий HTTP, требует status 200 и CSS
   MIME, фиксирует SHA байтов и лишь затем отправляет `load`. При отказе он отправляет
   `error`, который уже получает настоящий `loadPluginStyles()`.

`WeakSet` не даёт двум формам append обработать один link дважды. Настройка
`handleDisabledFileLoadingAsSuccess` остаётся выключенной: автоматический ранний
load нарушил бы проверку ожидания HTTP. Продуктовый loader и assertions не меняются.

[Packaged browser-проверки](../../../tests/web/studio3d-plugin-package-browser.integration.test.js)
подтверждают одновременную панель и восстановление pending с одним UUID/POST, а также
смену библиотеки через настоящий UI. Этот CSS-port проверяет протокол загрузки;
геометрия, отрисовка stylesheet и WebGL требуют отдельного настоящего браузера.
