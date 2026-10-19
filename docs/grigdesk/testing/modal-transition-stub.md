# Заглушка Transition делает предка Teleport-модалки inert

В component-тестах модалки с настоящим Teleport стандартная заглушка Vue Test Utils
создаёт `transition-stub` между body и overlay. Общий modalEnvironment регистрирует
сам overlay, а остальные дочерние элементы body делает inert. Из-за искусственного
предка inert получает и верхний диалог: нельзя сфокусировать его контролы, Tab
остаётся на открывшей кнопке.

Для проверки focus trap и возврата фокуса монтируйте с
`global: { stubs: { transition: false } }`. Продуктовый modalEnvironment изменять
не требуется: настоящий Transition не добавляет такого DOM-предка.

После закрытия настоящий Transition удаляет DOM после кадров анимации.
`flushPromises` недостаточен для проверки отсутствия узла. Используйте ограниченное
ожидание удаления; проверяйте скаляр наличия, а не сравнивайте DOM-узел в assert.

Проверено в `tests/web/settings-modal.component.test.js` (MD04, MD05, MD07).
