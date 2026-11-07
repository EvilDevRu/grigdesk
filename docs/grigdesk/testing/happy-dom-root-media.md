# Happy DOM: селектор :root внутри media

В закреплённой версии Happy DOM `CSSStyleDeclarationComputedStyle.parseCSSRules`
особо обрабатывает любой selectorText, начинающийся с `:root`. При рекурсивном разборе
media он не передаёт rootElement, поэтому правило игнорируется даже при совпавшем media
и положительном `element.matches()`. Это касается и custom properties, и descendant
selectors вроде `:root .ui-input`.

Для настоящего CSS, который должен проверяться через computed style, запись `html:root`
избегает этой специальной ветки и сохраняет выбор корня HTML-документа. Она используется
в телефонном блоке tokens и финальных overrides fields.css. Не заменять computed style
или matchMedia заглушками. После изменения viewport по-прежнему требуется
[повторно присвоить CSS подключённому style](happy-dom-media-cache.md).

Ограничение относится к тестовой среде; это не свидетельство дефекта Chromium/WebView.
