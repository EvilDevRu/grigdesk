# Всплывашка открывается только в первом тесте файла = Vue запомнил document первого окна

**Где:** `tests/web/*.component.test.js`, где в одном файле несколько `test(...)`, каждый зовёт
`installUiBrowser(t)` и монтирует поверхность с `Teleport to="body"` (`UiPopover`, `UiTooltip`,
`UiDialog`).

Симптом: первый тест файла открывает всплывашку, а во втором `browser.document.querySelector('.ui-popover')`
пуст, хотя `aria-expanded="true"` на триггере выставлен и ошибок нет. Порядок решает: тот же
тест один (`--test-name-pattern`) проходит, после ЛЮБОГО соседа — падает. Кэш `data:`-модулей
тут ни при чём (nonce в URL уже есть).

Механика: `vue/index.mjs` — общий singleton на процесс, и `@vue/runtime-dom` запоминает
`document` при ПЕРВОМ импорте (`const doc = typeof document !== 'undefined' ? document : null`).
`installUiBrowser` каждого теста подменяет глобальный `document` новым окном happy-dom и
закрывает старое, а `Teleport` по-прежнему ищет `body` через сохранённый `doc` — содержимое
уезжает в закрытое окно первого теста.

Лечение: один браузер на файл — верхний `test('…', async (t) => { const browser = await
installUiBrowser(t); … })` и сценарии подтестами `await t.test(...)`, каждый со своим `mount`
и `scenario.after(() => wrapper.unmount())`. Компонент тоже компилируется один раз, а заглушки
сторов читают `globalThis[KEY]` при ВЫЗОВЕ (`export const useX = () => globalThis[KEY].x`),
а не в top-level `const` — тогда у каждого подтеста свежие сторы. Образец —
`tests/web/cockpit-version-tile.component.test.js`.
