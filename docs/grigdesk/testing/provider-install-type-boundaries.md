# Типы тестов установки и границы импорта UI

`web/src/stores/providers.ts` используется напрямую из Node в серверном тесте Tripo.
Реестр не импортирует store установки: тот подключает обработчик `updateCli` через
`connectProviderCliUpdate` при загрузке. Обработчик выбирает store текущей Pinia
при вызове; экземпляр чужого окна или сессии в нём не сохраняется.

Это оставляет общий confirm в `web/src/ui.ts`, а импорт реестра для чтения моделей
и лимитов не загружает Vue-компоненты. Статический обратный импорт установки из реестра
ломает и прямой Node import, и серверную проверку типов с `moduleResolution: NodeNext`:
она не обрабатывает SFC и импорты UI без расширения.

Веб-фикстуры установки импортируют настоящие серверные providers/auth. Поэтому
`web/tsconfig.tests.json` включает `server/src/lib/fastifyDecorations.ts`: это единственное
объявление полей `sse`, `authKind` и `authPrincipal`. Дублировать объявления или ослаблять
строгую базу проверок не требуется.

Проверки: `npm --prefix server run typecheck:tests`,
`npm --prefix web run typecheck:tests`; поведение — подготовленные тесты установки
и `tests/server/tripo-provider.test.js` через сторож памяти с явным списком файлов.
