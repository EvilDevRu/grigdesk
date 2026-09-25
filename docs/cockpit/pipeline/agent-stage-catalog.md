# База агентов (modules/agents) — стадии конвейера

- `agents/<id>.md` в корне проекта (самогитигнор): frontmatter (kind/label/sub/key/model/timeout/budget/readonly/optional) + тело-промпт. Формат плоский key: value — парсер свой (`store.js`), не YAML-библиотека.
- CRUD: `GET/POST /api/agents`, `GET/PUT/DELETE /api/agents/:id`, `POST /api/agents/reseed`.
- Пустая база один раз засевается из всех профилей фабрики. Reseed обновляет метаданные
  канонических стадий, сохраняет курируемые `prompt` и `effort`, кастомных агентов не трогает.
- UI: AgentsView (`/agents`) — список + редактор карточки; «Профи»-настройки за тумблером.

Источник до переноса: docs/cockpit/chat-agents.md § База агентов (modules/agents) — стадии конвейера
