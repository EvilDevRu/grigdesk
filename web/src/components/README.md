# UI-компоненты Cockpit

`web/src/ui.ts` — единственная публичная точка импорта. Страницы, features и layout не
импортируют deep paths из `components/`, `types/`, `services/` или private composables.
Компоненты не знают о Pinia, router, API и доменных сущностях Cockpit.

В Vue SFC блоки идут в порядке: `<template>`, затем `<script ...>`/`<script setup ...>`, затем
`<style ...>` (если он есть). Новые компоненты `web/src/components/` пишутся с
`<script setup lang="ts">`; JavaScript допустим в legacy-consumers до их отдельной
миграции. Production UI-компоненты не содержат `<style>` и используют skin только из
`web/src/styles/components/`.

Script разделяется пустыми строками на imports, public contract, state/computed и actions.
Несколько полей объекта или type literal не уплотняются в одну строку, control-flow всегда
использует фигурные скобки. Нетривиальная функция получает многострочный русский комментарий
о причине, инварианте или побочном эффекте; очевидный getter не обрастает формальным шумом.

Нативными `button`, `input`, `textarea` и `select` владеют только файлы
`components/primitives/`. `UiFileInput` и field wiring остаются private. Обычная action
собирается через `UiButton`, icon-only action — через `UiIconButton` с обязательным `label`,
а настоящая action-ссылка — через `UiActionLink`. `UiPressable`/`UiSvgPressable` предназначены
только для доменных поверхностей, которым стандартный button skin не подходит.

Обычные peer-controls всегда получают `--control-height: 36px` и
`--control-radius: 9px`. Consumer управляет раскладкой, но не переопределяет `.ui-*`,
`--ui-*`, высоту, радиус, focus ring или state skin. Смысл задаётся через `variant`, `tone`,
`loading`, `disabled`, `ariaDisabled`, `invalid`, `pressed` и `selected`.

`loading` относится к одному action и блокирует повторную активацию, сохраняя focus.
`busy` описывает composite/region и не блокирует потомков автоматически. Tooltip содержит
только справку; интерактивная поверхность использует popover. Все modal overlays проходят
через `UiDialog` и единый stack, а простые Promise-вопросы — через `confirmDialog`,
`promptDialog` и `alertDialog`.

Обязательные локальные проверки: `npm run typecheck:ui`, `npm run check:sfc`,
`npm run check:ui`, `npm run check:ui-styles`, `npm run check:readability` и `npm test`.
Настоящую раскладку проверяет `npm run test:ui-browser`: команда поднимает отдельный Vite
entry `ui-gallery.html`, запускает Chrome с временным profile и проходит матрицу ширин.
Путь к браузеру можно задать через `CHROME_BIN`, а готовый dev server — через
`UI_GEOMETRY_BASE_URL`.
