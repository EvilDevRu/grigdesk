# Веб (web/src/)

- `views/`: Board (доска B24), Pipeline (конвейер + модалка этапа), Agents (база агентов-стадий),
  Chats (телеграм-раскладка чатов), Routes (редактор маршрутов + живой превью),
  Projects, Code (дерево/файл/git), Shelf (полка задач), Documents (скрытый route просмотра MD/TXT),
  Diff (Monaco), Tools (агрегатор), Video, Terminal,
  Settings (Приложение / Речь / Битрикс24 /
  Исполнители / Запуски / Плагины / Сервер / Доступ), Login
  и TaskModal. Полный `ChatSession` монтируется только в `ChatsView`; компактной chat
  surface поверх страниц больше нет (компаньон удалён 2026-09-10).

Источник до переноса: docs/cockpit/architecture.md § Веб (web/src/)
