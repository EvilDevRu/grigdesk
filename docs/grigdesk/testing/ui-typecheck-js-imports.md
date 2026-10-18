# Проверка типов UI и импорты JavaScript

`web/tsconfig.ui.json` включает composables, которые ещё импортируют JS-сторы.
Например, `useUiContextSource.ts` использует `stores/ui-context.js`. При унаследованном
`allowJs: false` проверка выдаёт TS7016: для импортируемого модуля нет декларации типов.

Область UI явно задаёт `allowJs: true`, чтобы TypeScript включал такие импорты.
`strict` остаётся включённым, а `checkJs` наследует значение `false` из общей базы:
эта настройка не переводит все старые JS-сторы на строгую проверку.

Проверка реальной конфигурации: `npm --prefix web run typecheck:ui`.
