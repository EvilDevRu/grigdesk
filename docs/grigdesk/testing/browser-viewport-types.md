# Типы native bridge в mounted fixture

Производственная web-программа включает src/types/browserNative.d.ts через общий glob.
Тестовая программа имеет отдельный include и должна подключать эту декларацию явно.
Иначе импорт BrowserViewport через harness приводит к ошибкам grigdeskBrowser у Window,
хотя production typecheck и выполняемые Node-тесты зелёные.

Mounted fixture загружает Vue после создания DOM. Прямые импорты runtime .mjs из
node_modules исполняются в Node, но не имеют собственной декларации для строгого tsc.
URL динамического импорта сохраняет порядок загрузки; Promise<typeof import('vue')>
и соответствующий тип @vue/test-utils используют настоящие пакетные декларации.
Runtime suite и проверка типов проверяются отдельно.
