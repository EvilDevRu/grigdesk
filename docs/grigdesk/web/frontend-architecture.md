# Веб (web/src/)

- `views/`: Board (доска B24), Pipeline (конвейер + модалка этапа), Agents (база агентов-стадий),
  Chats (телеграм-раскладка чатов), Routes (редактор маршрутов + живой превью),
  Projects, Code (дерево/файл/git), Shelf (полка задач), Documents (скрытый route просмотра MD/TXT),
  Diff (Monaco), Tools (агрегатор), Video, Terminal,
  settings/SettingsModal (Интерфейс / ИИ-исполнители / Чаты и конвейер /
  Речь и расшифровка / Подключения и доступ / Плагины / Система), NoAccess
  и TaskModal. Полный `ChatSession` монтируется только в `ChatsView`; компактной chat
  surface поверх страниц больше нет (компаньон удалён 2026-09-10).

Источник до переноса: docs/grigdesk/architecture.md § Веб (web/src/)

Оболочка настроек монтируется лениво в authenticated-ветке App поверх постоянной
страницы. `stores/settings.ts` связывает UI с чистой сессией `features/settings/`;
значения ресурсов сохраняются общим Apply, операции выполняются отдельными кнопками.
