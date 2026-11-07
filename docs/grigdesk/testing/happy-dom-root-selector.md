# Happy DOM: условие после :root

В Happy DOM 18.0.1 ветка `CSSStyleDeclarationComputedStyle.parseCSSRules` применяет
любой селектор, начинающийся с `:root`, к корню без проверки оставшейся части селектора.
Поэтому `:root[data-ui-touch]` включает сенсорные токены даже у desktop без атрибута.
Это отличается от [пропуска :root внутри media](happy-dom-root-media.md): здесь
правило вне media применяется безусловно.

В `tokens.css` условный корень записан как `html:root[data-ui-touch]`. Для HTML-клиента
это тот же выбор элемента, но Happy DOM обрабатывает его обычным сопоставлением CSS.
Проверка `phone-readability.component.test.js` различает 28 px desktop-действия,
32 px видимой кнопки touch и 44 px сенсорной площадки, используя настоящий computed style.
