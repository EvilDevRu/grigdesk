# Штатные подтверждения и Auto-review Codex

У Codex есть встроенные механизмы проверки разрешений. Для их подключения не требуется
писать собственный классификатор опасных shell-команд GrigDesk.

Обычный режим сохраняет `sandbox_mode="workspace-write"` и использует
`approval_policy="on-request"`, `approvals_reviewer="user"`: запрос решает человек.
Режим Auto-review меняет reviewer на `auto_review`; отказ сообщает причину агенту,
которому предписано искать более безопасный вариант либо обратиться к человеку.
Это не обещание автоматической карточки подтверждения каждого опасного действия.

Auto-review рассматривает только действия, для которых уже требуется разрешение.
Команда, допущенная внутри песочницы, отдельной проверки не получает; `never`
не запускает Auto-review. Источник — [Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review).

Штатные правила команд (`allow`, `prompt`, `forbidden`) описаны в
[Rules](https://learn.chatgpt.com/docs/agent-configuration/rules) и
[рецепте согласования чувствительных команд](https://learn.chatgpt.com/docs/enterprise/security-cookbook#require-approval-for-sensitive-commands).
Правила являются экспериментальным механизмом. `prompt` при Auto-review означает
передачу выбранному reviewer; если решение обязательно должен принимать человек,
документация требует reviewer `user`. Префиксные правила не распознают все возможные
эффекты произвольной программы и не заменяют файловую изоляцию.

Для неинтерактивного раннера документирован `codex exec --approve-for-me`: включаются
workspace-write и автоматическая проверка запросов. Флаг конфликтует с `--sandbox`
и `--yolo`; нельзя просто дописать его к нынешнему argv конвейера.
Справка CLI 0.164.0 подтверждает наличие флага, но не является живой проверкой
допуска конкретного Git-действия. Источник — [Developer commands](https://learn.chatgpt.com/docs/developer-commands).

Обычный чат GrigDesk явно выбирает `on-request` и `auto_review` при start/resume
и на каждом ходе. Служебный `workspaceAccess` сохраняет `never` и reviewer `user`;
изолированный untrusted runner также остаётся с `never`. Результаты native review
попадают в существующую ленту заметок; ручные command/file/permissions approval
requests не поддерживаются и закрывают собственный процесс с ошибкой —
см. [контракт адаптера](codex-mcp-approvals.md) и [проверенные границы](codex-auto-review-runtime.md).

## Проверка протокола CLI 0.164.0

Схема `codex app-server generate-ts --experimental` содержит отдельное RPC-поле
`approvalsReviewer` в `thread/start`, `thread/resume` и `turn/start`; enum допускает
`auto_review`. Ответы start/resume также содержат фактический reviewer и approval policy.
В отдельном эфемерном thread проверено: запрос `on-request` + `auto_review` +
`workspace-write` возвращает те же approval-настройки и sandbox типа `workspaceWrite`.
Turn, reviewer и операции Git в этой проверке не запускались. Автоматизированный
сторож установленного CLI закрепляет поля start/resume/turn и effective readback start.

Схема также объявляет уведомления `item/autoApprovalReview/started` и `/completed`.
Завершённое review содержит `reviewId`, `targetItemId` (может быть null), действие,
статус и краткое rationale. Payload помечен unstable: его потребители должны иметь
проверку совместимости. Отображение этих уведомлений проверяется протокольной fixture
0.164.0. Принятие режима при handshake не доказывает разрешение конкретного commit.
