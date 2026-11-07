interface HistoryEntry {
  role?: string;
  text?: unknown;
  turnId?: unknown;
  [field: string]: unknown;
}

/**
 * Executor получает историю до текущего user turn, включая принятые сервером ответы.
 * Более поздние сообщения очереди и сам текущий prompt не должны попасть в replay дважды.
 */
export function historyBeforeTurn(messages: HistoryEntry[], turnId: string | undefined, message: string) {
  const index = turnId
    ? messages.findIndex((entry) => entry.role === 'user' && entry.turnId === turnId)
    : -1;

  if (index >= 0) {
    return messages.slice(0, index);
  }

  const last = messages.at(-1);

  return last?.role === 'user' && last.text === message ? messages.slice(0, -1) : [...messages];
}
