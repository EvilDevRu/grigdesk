# Компактный companion удалён; остался server-owned companion-чат

Компактный голосовой компаньон (пузырь поверх страниц, фигурка-аватар, знак в топбаре,
браузерная озвучка TTS, карточка «Настройки → Приложение → Голосовой компаньон», кнопка
«Обсудить с агентом» в модалке этапа конвейера) удалён 2026-09-10 по решению владельца:
после выпуска 2026-08-22 им не пользовались — все его разговоры датированы днями обкатки
(21–26 августа), а обычных чатов за то же время создано больше двухсот. Держать его стоило
около 2 600 строк кода, 3 400 строк своих тестов и стабов стора в трёх десятках чужих
тестов; каждая правка стора чатов или модуля чата тащила ветки `purpose === 'companion'`.

Что ОСТАЛОСЬ и почему:
- **Server-owned companion-чат** — обычная запись истории с `purpose: "companion"` и
  `logicalIdentity` (`companion:global` / `companion:task:<id>`). Создаётся только через
  `POST /api/chat/store/ensure` под logical-key lock; обычный PUT не может назначить или
  перепривязать `purpose`/`taskId`; дубли дают явный `409 companion_chat_conflict`.
  Потребитель — Telegram-пульт: кнопка «💬 Агент» ведёт обычный auto-ход именно в общий
  companion-чат (`lib/telegram/pult/assistant.ts`). На `/chats` такой чат виден как
  «Компаньон» и «Компаньон · задача #N».
- **Scope-preflight на сервере** (`companionScopePreflight` в `modules/chat/index.ts`):
  ход по companion-чату обязан идти маршрутом своей identity — общий через `/api/chat`,
  задачный через `/api/tasks/<id>/chat`, иначе `409 companion_scope_mismatch`; повреждённая
  identity даёт `409 companion_chat_required`. Проверка идёт до очереди, binding и session
  state. Сторож — `tests/server/chat-companion-contract.test.js`.
- **Селект задачи у companion-чата на `/chats` неактивен**, `chat.setTask` для него — no-op,
  `newSession({purpose:'companion'})` бросает: `taskId` принадлежит identity, а не человеку.
- **Модель и усилие принадлежат самой записи чата**, как у любого разговора: селекты на
  `/chats` активны, отдельной серверной настройки `prefs.companion` больше нет. Это заодно
  сделало правдой подсказку пульта «открой /chats и выбери совместимую модель».

Что снято ЦЕЛИКОМ (не восстанавливать по старым описаниям): маркер быстрого хода
`companionTurn` и его plan-only gate с проверкой exact worktree, серверный вердикт
`speechSafe`, слой `companion` в UI-layers, `stores/companion.js`, `features/companion/`,
`shared/companion-run.js`, `lib/companionSettings.ts`, device-prefs
(`cockpit-companion-device-v1` — `App.vue` один раз чистит ключ из localStorage).
`routingScope` в `stores/ui-context.js` остался описательным полем без потребителя.
