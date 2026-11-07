# Подмены асинхронных компонентов и оболочки настроек

В component-тестах с `compileVue` динамический импорт подменённого компонента возвращает
namespace esbuild. Для `defineAsyncComponent` подмена экспортирует `__esModule = true`,
чтобы Vue взял default-компонент. Без этого Vue пишет «Component is missing template or
render function» и получает `{ default: … }` вместо компонента. Настоящие lazy imports
продукта сохраняются; подменяется точный specifier. Проверено тестами оболочки настроек и App.

Memory-router под `NODE_ENV=production` при установке в app читает
`__VUE_PROD_DEVTOOLS__`: fixture объявляет `globalThis.__VUE_PROD_DEVTOOLS__ = false` до
установки роутера. Vue и vue-router берутся из тех же singleton, что compiler helper.

AppShell получает `useSettingsStore` и `openSettings` через явные подмены, если тест
проверяет только топбар. Иначе непрямой импорт launcher может втянуть registry, Monaco
CSS и шрифты. Полная фикстура новых страниц использует настоящие Pinia и сессию,
подменяет HTTP и router, не копирует бизнес-логику формы.
