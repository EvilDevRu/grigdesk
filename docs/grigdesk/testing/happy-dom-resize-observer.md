# ResizeObserver в окружении компонентных тестов

Наличие `window.ResizeObserver` в happy-dom не создаёт одноимённый глобальный
конструктор Node.js. Код, вызывающий `new ResizeObserver(...)`, падает при монтировании,
если helper переносит из окна только `MutationObserver` и другие DOM-объекты.

`tests/web/helpers/ui-components.js` устанавливает в глобальное окружение также
`browser.ResizeObserver`. Компоненты, использующие `svgPixelSnap.ts`, получают
тот же конструктор, что и окно теста. Это требуется, в частности, при монтировании
настоящего топбара в `tests/web/executor-types.component.test.js`.

Проверка проходит через `tests/run-node-tests-safe.sh`; подменять сам компонент
заглушкой для устранения этой ошибки не требуется.
