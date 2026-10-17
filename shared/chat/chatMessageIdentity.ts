type Message = Record<string, unknown> | null | undefined;

/**
 * Устойчивый ключ общий для слияния истории и её проекции перед следующим ходом.
 * У ответа id блока важнее pid: перенос через pending не создаёт новое сообщение.
 */
export function stableMessageKey(message: Message): string {
  const pid = typeof message?.pid === 'string' ? message.pid : '';
  const messageId = typeof message?.messageId === 'string' ? message.messageId : '';
  const assistantId = typeof message?.assistantMessageId === 'string' ? message.assistantMessageId : '';
  const turnId = typeof message?.turnId === 'string' ? message.turnId : '';
  const assistantKey = assistantId
    ? `assistant\u0000${String(message?.runId || '')}\u0000${assistantId}` : '';

  if (assistantKey && message?.role === 'assistant') {
    return assistantKey;
  }
  if (pid) {
    return `pid\u0000${pid}`;
  }
  if (messageId) {
    return `message\u0000${messageId}`;
  }
  if (assistantKey) {
    return assistantKey;
  }
  if (turnId) {
    return `turn\u0000${turnId}\u0000${String(message?.role || '')}`;
  }

  return '';
}

/**
 * Старые записи без id опознаются по роли и тексту.
 * Отдельный ключ также связывает такую запись с её копией, уже получившей id.
 */
export function legacyMessageKey(message: Message): string {
  return `legacy\u0000${String(message?.role || '')}\u0000${String(message?.text || '')}`;
}

/**
 * Постоянный id имеет приоритет над текстом во всех проекциях истории.
 * Совпадение текста используется только для записей без собственного ключа.
 */
export function messageKey(message: Message): string {
  return stableMessageKey(message) || legacyMessageKey(message);
}
