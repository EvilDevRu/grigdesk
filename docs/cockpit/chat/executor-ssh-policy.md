# Запрет прямого SSH — настройка каждого исполнителя, а не общая политика UI

- **Запрет прямого SSH — настройка каждого исполнителя, а не общая политика UI.** Адаптер
  объявляет capability `directSshPolicy` и свой toggle `blockDirectSsh`; выбор хранится
  только как `providerSettings.<id>.blockDirectSsh`. Отсутствующий ключ означает
  «по умолчанию включено» (`true`) и для старых установок. Выключение объявлено через
  `settings[].confirm.off`: существующий `POST /api/providers/:id/settings` принимает
  `{ settingId: "blockDirectSsh", value: false, confirmed: true }`, а без точного
  `confirmed: true` отвечает `confirmation_required` и prefs не меняет. Включение обратно
  подтверждения не требует. У Claude и Codex `providerSettings` входит в `restartOn`,
  поэтому следующая попытка получить сессию переоткрывает процесс с новой policy.

  | исполнитель / режим | `directSshPolicy.enforcement` | как держится запрет |
  |---|---|---|
  | Claude | `command-hook` | нативный deny для прямой формы и server-owned PreToolUse |
  | Codex | `command-hook` | process hook, подтверждённый через `hooks/list` до thread |
  | Ollama | `tool-filter` | фильтр Cockpit до permission mode и запуска `bash` |
  | Kimi contained | `network-sandbox` | egress разрешён только API Kimi |
  | Kimi host | `fail-closed` | при включённом запрете весь ход отклоняется до spawn |

Источник до переноса: docs/cockpit/chat-agents.md § Запрет прямого SSH — настройка каждого исполнителя, а не общая политика UI.
