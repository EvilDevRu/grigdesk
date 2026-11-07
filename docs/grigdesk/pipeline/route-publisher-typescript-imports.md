# Скрипты публикации маршрутов получают схему от сервера, а не по относительному пути

Скрипты профилей `profiles/<имя>/routes/publish.mjs` и `definition.test.mjs` проверяют маршруты
схемой сервера и пишут бандлы его хранилищем. «Маршруты → Проверить/Опубликовать» запускают
`publish.mjs` дочерним Node с рабочей папкой профиля (`server/src/modules/routes/api.ts`,
`POST /api/routes/:profile/publish`).

## Почему не относительный импорт

Раньше скрипты импортировали `../../../server/src/modules/routes/schema.ts` и `store.ts`. Этот
путь ломался трижды:

1. **Миграция на TypeScript (10.09.2026).** Импорты остались с `.js`, которых больше нет, —
   `ERR_MODULE_NOT_FOUND`.
2. **Переезд профилей в папку данных.** В дереве кода на `<папка данных>/profiles` ведёт ссылка
   `profiles/`. Node разрешает относительный импорт от настоящего расположения файла, поэтому
   путь уходит в `<папка данных>/server/...` и снова даёт `ERR_MODULE_NOT_FOUND`.
3. **Сервер из бинарника (SEA).** В комплекте нет исходников `server/src/**/*.ts`, только
   payload и helper-ы `server/runtime/helpers/*.mjs`, — искать схему скрипту негде.

## Как устроено

- `server/src/modules/routes/publishKit.ts` отдаёт ровно пять имён: `RoutesStore`,
  `validateBootstrap`, `validateCatalog`, `validatePromptFiles`, `validateRoute`. В
  `server/build/helpers.json` он — library-helper `routes-publish-kit`, сборка комплекта
  собирает его в `server/runtime/helpers/routes-publish-kit.mjs`.
- Сервер передаёт скрипту путь к файлу набора в `GRIGDESK_ROUTES_KIT` (`helperModule` в
  `server/src/lib/runtimePaths.ts`): из исходников — `publishKit.ts`, из комплекта — собранный
  `.mjs`. Остальное окружение сервера наследуется.
- В профиле набор подключает `routes/routes-kit.mjs`: `GRIGDESK_ROUTES_KIT`, иначе
  `<текущая папка>/server/src/modules/routes/publishKit.ts`. Ручной запуск и тесты профиля идут из
  корня дерева кода (`node profiles/<имя>/routes/publish.mjs --validate`) — флаги ссылок не нужны.
  У профиля grigdesk то же делает `routes/code-root.mjs`; без дерева кода его `root` — `null`, и
  проверка «не публикуй в legacy routes/» пропускается.
- Новый профиль из шаблона берёт схему только через `routes-kit.mjs`; относительных импортов
  `../../../server/` в скриптах профиля быть не должно.

Проверки: `tests/server/sea-runtime-paths.test.js` (`SEA-RP-10`),
`tests/server/routes-api.test.js` (`ROUTES-API-14`), `tests/server/sea/engine.test.mts`
(`SEA-ENGINE-03` — собранный набор в комплекте без `server/src`).
