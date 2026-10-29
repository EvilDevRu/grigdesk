# Auto-review Codex: запуск, события и граница проверки

Режим `auto` chat adapter явно задаёт on-request/auto_review во всех start/resume/turn.
Effective readback policy/reviewer и sandbox workspaceWrite проверяется до turn:
при несовпадении процесс закрывается с русской причиной и сохранённым thread id.
Пользовательские native settings не владеют этими параметрами. `workspaceAccess`
явно получает never/user с прежними roots, сетью и tmp; untrusted runner не меняется.

`item/autoApprovalReview/completed` превращается в ограниченную заметку существующей
ленты: native status, краткое действие и rationale. Причина сохраняется даже когда
agentMessage её не повторил. ReviewId дедуплицируется внутри одного хода; разные
review одного item различаются, null targetItemId допустим. Routing thread/turn
отсекает чужие и старые события до нормализации. Approved не заменяет результат
команды, denied/timedOut/aborted не создают успешный результат инструмента.

Неожиданные ручные server requests получают ошибку без accept/override. Собственный
запрос закрывает native процесс и делает его недоступным для повторного send;
явно чужой запрос не прерывает активный родительский ход. Запрос без ownership
отвергается с закрытием процесса. Отдельный denied notification процесс не закрывает:
агент может продолжить разрешённым действием.

Native `item/tool/requestUserInput` обрабатывается отдельно от approvals: structured
вопросы поддержаны с native ID, отменой и отказом secret-форм до UI.
Другие чатовые профили и предел проверки описаны в [режимах Codex](codex-permission-modes.md).

Проверки `codex-auto-review.test.js` и `codex-app-server-contract.test.js` используют
версионированные fixture, без настоящих Git-прав и модели. Installed-contract test
генерирует схему CLI и открывает отдельный эфемерный thread без turn. На CLI 0.164.0
подтверждено принятие on-request/auto_review/workspaceWrite. Это не доказательство
работы reviewer, реального commit или миграции persisted legacy never/user rollout.
Native Git, linked gitdir, resume между процессами и сдача требуют отдельного live-допуска.
