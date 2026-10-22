# UI-контекст: чат знает, где пользователь

- Стор `ui-context` (`web/src/stores/uiContext.ts`) выдаёт каждому publisher-у owner token.
  `useUiContextSource()` обновляет bounded positive schema и гарантированно удаляет только
  свою запись при unmount. Focus-bearing overlay выше page, page выше dock; при равном
  приоритете побеждает последняя явная focus revision, а фоновое обновление title/status
  не крадёт scope.
- `capture(route)` один раз перед durable save/model POST возвращает две независимые части:
  trusted `routingScope` (описательная область global/exact-task; после сноса компаньона
  потребителя у неё нет) и frozen `promptContext` (`page/path/details`), который уезжает в
  HTTP. `routingScope`, query/hash и DOM в HTTP не сериализуются; `details.taskId/scope` не
  могут выбрать route или worktree.
- Клиент ограничивает глубину/число ключей/массивы/строки/общий JSON и рекурсивно удаляет
  secrets, getters, функции, циклы, prototype keys и control/bidi. Сервер повторяет эти
  проверки: details остаются недоверенными данными prompt, а не каналом полномочий.
- `ToolHost` добавляет безопасный контекст Code (проект, рабочая копия, открытый файл и
  режим `page`/`dock`). Для Terminal наружу уезжают только id и режим представления:
  buffer xterm, вывод PTY и введённые команды в `ui-context` не попадают.
- Серверные `normalizeUiContext()`/`contextPrefix()` экранируют JSON внутри собственного
  `[Контекст GrigDesk]` framing. Exact `pageHint()` даёт только описание страницы.
  Клиентский path, включая `/agents`, больше не меняет cwd или permission mode; worktree
  выбирает только task-chat route и сохранённая server identity.

Источник до переноса: docs/grigdesk/chat-agents.md § UI-контекст: чат знает, где пользователь
