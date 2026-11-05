# Новые модели Anthropic обнаруживаются сами

- **Новые модели Anthropic обнаруживаются сами** (`claude.js discoverModels` → `/v1/models`):
  вотермарк по `created_at` в `_meta` models.json — всё, что свежее и неизвестно, дописывается
  наверх списка (tier выше максимума). Авторизация: `ANTHROPIC_API_KEY` из окружения, либо
  OAuth-токен хостового CLI — ТОЛЬКО при явном опт-ине `GRIGDESK_DISCOVER_WITH_CLI_TOKEN=1`
  (без него сервер в чужие креды не лезет). Для Codex общая Platform-ручка `/v1/models`
  намеренно не используется: она не отражает доступ конкретного ChatGPT/Codex-аккаунта.
