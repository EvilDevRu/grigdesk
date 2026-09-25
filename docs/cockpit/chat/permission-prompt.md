# Всплывашка разрешений (аналог permission prompt Claude Code)

- Чат работает в `--permission-mode default`: чтение свободно, на действия (Bash/правки) claude
  спрашивает через `--permission-prompt-tool mcp__cockpit-perm__approve` — мини-MCP
  `lib/chat/permission-mcp.js` (newline-JSON-RPC вручную, без SDK), который держит HTTP-запрос
  к `/api/chat/permission-request`, пока пользователь не ответит.
- Поток: claude → MCP → POST permission-request → SSE `chat-permission {pid,tool,input,chatKey,at}` →
  всплывашка в ChatSession (жёлтая, показывает команду/файл) → POST `/api/chat/permission/:pid`
  {allow, comment?} → `chat-permission-done` закрывает всплывашку во всех окнах.
- **Нюанс:** то, что уже в глобальном allowlist пользователя (~/.claude/settings.json), выполняется
  БЕЗ всплывашки — prompt-tool зовётся только для того, что иначе спросило бы.

Источник до переноса: docs/cockpit/chat-agents.md § Всплывашка разрешений (аналог permission prompt Claude Code)
