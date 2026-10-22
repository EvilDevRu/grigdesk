# База агентов (modules/agents) — стадии конвейера

Библиотека содержит шаблоны ролей и инструкции для автора маршрута. Правка карточки
не обновляет существующие маршруты и запущенные задачи: инструкция этапа принадлежит
маршруту, параметры исполнителя — проекту.

- `<папка данных>/agents/<id>.md`: frontmatter
  (`kind/label/sub/key/tier/effort/timeout/budget/readonly/optional`) и тело инструкции.
  Парсер поддерживает плоские `key: value`, без YAML-библиотеки.
- CRUD: `GET/POST /api/agents`, `GET/PUT/DELETE /api/agents/:id`.
- `POST /api/agents/install` доустанавливает отсутствующие файлы из версионируемого
  `server/seed/agents`. Существующие роли и пользовательские правки не перезаписываются.
  Startup не меняет библиотеку.
- `POST /api/agents/reseed` предоставляет preview посева из профилей. Применение
  legacy reseed отключено до атомарного immutable-хранилища.
- UI: [библиотека и редактор](../web/agents-design.md) на `/agents`.
