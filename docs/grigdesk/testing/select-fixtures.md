# Проверки общего поля выбора

Видимый `UiSelect` — кнопка и телепортированный список. Hidden native select сохраняет
контракт адаптера формы; его id имеет суффикс `-native`, а исходный id и классы поля
находятся на кнопке. Тесты данных могут сохранять native `setValue()`, явно находя
адаптер. Вызов setValue по прежнему class/id кнопки заканчивается ошибкой BUTTON.

Браузерные сценарии используют `tests/web/helpers/selectUiOption.ts`: значение
сопоставляется с индексом исходных options, после чего helper кликает настоящую кнопку
и строку списка. Он не присваивает value и не вызывает synthetic change. Это сохраняет
проверку disabled, прокрутки, слоёв и обработчиков. `selectOption()` и `inputValue()`
Playwright применимы к native control; у кнопки проверяют видимую подпись. Геометрия
поля измеряется по `button.ui-select`, а не по скрытому select с нулевой высотой.

В happy-dom свойство option.label без явного атрибута не повторяет браузерный fallback
на текст. Адаптер вариантов использует `option.label || option.text`; отдельный тест
закрепляет подпись. Один document на component-файл остаётся обязательным для Teleport.

Проверка required должна учитывать настоящую HTML-семантику: пустой placeholder для
single select должен быть первым option непосредственно внутри select. Пустой вариант
в optgroup считается обычным вариантом и не даёт valueMissing в Chromium. Общая
браузерная фикстура проверяет reportValidity, FormData и reset с direct placeholder.
