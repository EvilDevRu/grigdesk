# Native-пробы режимов Codex без облачной модели

`tests/server/codex-permission-mode-native.test.js` запускает настоящий установленный
CLI с отдельными synthetic HOME/CODEX_HOME и loopback Responses. Auth/config/hooks
человека не копируются. Подменяется ответ модели, а shell/patch исполняет native CLI.
Маркеры показывают эффект независимо от текста финального ответа.

Проверяются контрпримеры on-request/read-only и untrusted с разрешающим правилом,
автоматический новый `.env`, workspace/sibling границы never-профиля, wrapped adapter
с двумя send и native cleanup. Отдельный конечный detached-процесс доказывает, что
пустой native terminal list не гарантирует отзыв полного доступа; bypass закрыт.

`GRIGDESK_CODEX_NATIVE_ARTIFACTS` задаёт каталог синтетических fixtures. Без него тест
использует системный временный каталог. В manifest не записывается process.env.
Каждый case ограничен 30 секундами; завершается только собственное дерево/группа.

Вложенная родительская песочница может скрывать каталог native app-server socket
с mode 000. Ошибка «socket directory must be a user-owned directory with mode 0700»
не считается проверкой запрета действия: инструмент фактически не стартовал.
Такие cases выполняются только в отдельно разрешённой среде. Нельзя исправлять
разрешения настоящего daemon-каталога или обходить запрещённую escalation.

Протокольные `codex-permission-modes`, `codex-questions`, `codex-approvals` используют
fixtures и не заменяют native acceptance. Fake clock проверяет суточный deadline без
реального ожидания. Native-пробы не доказывают качество настоящего Auto-review или
работу модели с живой авторизацией.
