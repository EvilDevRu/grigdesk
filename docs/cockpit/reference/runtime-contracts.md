# Дополнительные runtime-контракты

Основные знания читаются по живым ссылкам карт `docs/cockpit/*.md`; этот файл сохраняет
короткие runtime-инварианты, которым недостаточно одного заголовка карты.

## SSH-плагин

Ручной raw connect с паролем отправляет `application/octet-stream` только на localhost
или через HTTPS; пароль не хранится и не попадает в JSON. Human shell и agent exec —
разные режимы, SFTP доступен только человеку. Для подтверждений действует одна общая
очередь; origin-aware ответ идёт через `/api/ssh/approvals/:pid`.

Bridge-провайдеры — Claude, Codex, Kimi и Ollama. Доступ агента привязан к доверенному
attempt (trusted attempt), а у свободного чата task scope равен null. Вывод сервера
недоверенный: prompt injection не получает инструментов. Один ToolHost обслуживает все
сессии; Telegram fail-closed не видит SSH-подтверждения, старый PWA bundle также
fail-closed и не разрешает новое действие.

Публичные endpoints: `/api/ssh/connections`, `/api/ssh/host-key/:challengeId`,
`/api/ssh/sessions`, `/api/ssh/sessions/:sid/agent-access`,
`/api/ssh/sessions/:sid/terminal`, `/api/ssh/sessions/:sid/files`, `/api/ssh/audit` и
`/api/ssh/approvals/:pid`. Host key проверяется через TOFU/known-host; недоверенный вывод
сервера остаётся риском prompt injection.

## Запрет прямого SSH исполнителям

Настройка `blockDirectSsh` хранится как `providerSettings.<id>.blockDirectSsh` и меняется
существующим `POST /api/providers/:id/settings` с `confirmed: true`. При отсутствии ключа
запрет по умолчанию включён (`true`). Claude использует command-hook, Codex — command-hook,
Ollama — tool-filter, Kimi — network-sandbox и host fail-closed. После изменения
`providerSettings` сессию надо переоткрыть или restart.

Это граница для кооперативного агента, не защита от намеренного обхода через base64/sh или
собственный SSH-клиент. Она не зависит от permission mode и не отменяется режимом прав.
`SSH_AUTH_SOCK` остаётся доступен; Git по SSH не блокируется. После выключения запрета
журнал подтверждений не создаётся. Старый PWA получает `confirmation_required`.
Пользовательский `permissions.deny` сохраняется: оба ограничения действуют совместно.
Проверка выполняется с временным `CLAUDE_CONFIG_DIR` и отдельным config, включая deny.

Для Kimi host-режим при недоступной политике закрывается fail-closed с typed-ошибкой
`direct_ssh_policy_unavailable`. Режим contained даже при `blockDirectSsh: false` остаётся
закрыт network/egress-песочницей.

## Telegram-пульт и companion

Телеграм-пульт **смотрит, разблокирует и поручает**. Постоянная клавиатура задаётся как
`ReplyKeyboardMarkup` с `is_persistent` и `resize_keyboard`: 📋 Конвейер, 💬 Агент,
📥 Задачи, ⚙️ Ещё. `setMyCommands` использует scope `BotCommandScopeChat` только в личке.

Общий companion создаётся через `store/ensure` с `purpose: companion` и `taskId: null`.
Обычный ход имеет `mode: auto` и идёт без `companionTurn`; `dontAsk` и
`bypassPermissions` никогда не обходят запрос решения. Тихий прогресс использует
`sendChatAction` со значением `typing` каждые 30 секунд и кнопку «Стоп». Память управляется
через `/api/chat/compact` и `/api/chat/session/reset`; голос отвечает «услышал: …» в одном
ответе. `/api/chat/active` показывает обрыв при перезапуске.

UI-компаньоном владеет `CompanionHost`; события несут `companionTurn`, `logicalIdentity` и
`routingScope`. `speechSynthesis` по умолчанию выключен. Недоверенный текст не получает
инструменты или сессию.
