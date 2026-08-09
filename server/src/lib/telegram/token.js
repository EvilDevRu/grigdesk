// Общие операции над Telegram bot token.
//
// Секрет хранится только в strict account-aware credential store. Этот модуль
// ничего не читает и не пишет: он проверяет форму token и готовит безопасную
// маску для UI/логов.

// Токен @BotFather: <id бота>:<секрет>. Точную длину секрета Telegram не
// документирует, поэтому закрепляем только устойчивую форму.
const TOKEN_RE = /^(\d{5,}):[A-Za-z0-9_-]{20,}$/;

export function isBotTokenShape(token) {
  return TOKEN_RE.test(String(token ?? '').trim());
}

export function maskToken(token) {
  const value = String(token ?? '').trim();
  return value ? `…${value.slice(-4)}` : '';
}
