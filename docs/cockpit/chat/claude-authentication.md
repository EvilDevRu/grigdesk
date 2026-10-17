# Авторизация Claude

- Настройки НЕ управляют ключом (форма удалена вместе с `/api/settings/claude*`); чат работает от хостового CLI
  (`claude login`) либо от ключа в `<папка данных>/state/claude-auth.json`, если тот был задан раньше (`ClaudeAuthStore` жив).

Источник до переноса: docs/cockpit/chat-agents.md § Авторизация Claude
