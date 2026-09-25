# Escape координирует единый typed stack

- **Escape координирует единый typed stack.** Consumers регистрируют semantic layer через
  `useUiLayer` из `web/src/ui.ts`; числовые приоритеты остаются private в
  `services/layers/priorities.ts`. Dock, tools-popover, модалки, confirm и popover закрываются
  по одному: одно нажатие действует только на верхний слой.
  Monaco/xterm помечают собственного владельца Escape и не отдают локальную клавишу стеку.
- `PipelineView` численно сопоставляет `task` карточки с `id` из `board.data.tasks` и отдельно
  от времени работы узлов показывает состояние B24-таймера. Идущий таймер дотикивается через
  `liveTimerSec(task, now)` общим секундным тиком страницы. Источник — уже загруженный снимок
  `GET /api/b24/dashboard` с `timerRunning`/`timerStartedAt`: отдельного запроса и нового
  polling нет, а для отсутствующей в снимке задачи статус не показывается.

Источник до переноса: docs/cockpit/architecture.md § Escape координирует единый typed stack.
