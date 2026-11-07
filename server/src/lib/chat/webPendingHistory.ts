import { normalizeContextUsage } from '../../../../shared/chat/chatContextUsage.ts';
import type { StoredChat } from './historyStore.ts';
import type { InTurnHistory } from './inTurnHistory.ts';
import { EMPTY_WORKDIR_MEMORY } from './workdirTransition.ts';

/**
 * Серверная проекция результата головы сохраняет durable уточнения и прежние поля финала.
 * Она применяется только под lock свежего файла и не переносит runtime окна в историю.
 */
export function applyWebPending(
  current: StoredChat,
  pending: Record<string, unknown>,
  projection: InTurnHistory,
  activeRunId: string | null,
): Partial<StoredChat> {
  const id = String(pending.id || '');
  const turnId = String(pending.turnId || '');
  const original = current.messages || [];
  const seen = original.some((message) => message.pid === id);
  const owns = (!activeRunId || activeRunId === pending.runId)
    && (!current.executionRunId || current.executionRunId === pending.runId);
  const rawUser = String(pending.userText || '');
  const seedMatch = rawUser.match(/^\[Выжимка предыдущего разговора[^\n]*\]\n([\s\S]*?)\n\[\/Выжимка\]\s*/);
  const seed = seedMatch?.[1] || '';
  const userText = seedMatch ? rawUser.slice(seedMatch[0].length) : rawUser;
  const userKnown = turnId ? original.some((message) => message.role === 'user' && message.turnId === turnId)
    : original.slice(-12).some((message) => message.role === 'user' && message.text === userText);
  const canonical = {
    ...pending,
    userText: pending.unsolicited || userKnown ? '' : userText,
    assistantMessageId: pending.finalAssistantMessageId || pending.assistantMessageId,
  };
  // Ответ мог уже лежать в ленте без pid: живое окно сохранило его по SSE, а durable
  // pending доехал позже и дополняет то же сообщение. Такой финал не «новый» — взводить
  // unread нельзя, иначе прочитанный ответ возвращает отметку «не прочитано» на всех
  // устройствах при очередном reconcile.
  const represented = original.some((message) => message.pid === id
    || (canonical.assistantMessageId && message.assistantMessageId === canonical.assistantMessageId
      && message.runId === pending.runId));
  const messages = projection.project({
    chatKey: String(current.id),
    base: original.map((message) => ({ ...message })),
    pending: pending.compact && !owns ? [] : [canonical],
  });
  const final = messages.find((message) => message.pid === id
    || (canonical.assistantMessageId && message.assistantMessageId === canonical.assistantMessageId
      && message.runId === pending.runId));
  const fields: Partial<StoredChat> = {};

  if (final && !seen) {
    Object.assign(final, {
      pid: id,
      role: pending.role || 'assistant',
      text: pending.reply || '(пусто)',
      // Уже сохранённая лента неизменяема: повтор pending дополняет метаданные финала,
      // а полную ленту назначает только новому сообщению без собственных steps.
      steps: Array.isArray(final.steps) ? final.steps : Array.isArray(pending.steps) ? pending.steps : [],
      cost: pending.cost ?? null,
      model: pending.model || '',
      actualModel: pending.actualModel || '',
      effort: pending.effort || '',
      serverCanonical: true,
      ...(pending.stopped ? { stopped: true } : {}),
      ...(pending.interruptedBy ? { interruptedBy: pending.interruptedBy } : {}),
    });
  }

  if (owns) {
    Object.assign(fields, pending.sessionReset ? EMPTY_WORKDIR_MEMORY : normalizeContextUsage(pending));

    if (pending.sessionId && !pending.sessionReset) {
      fields.sessionId = String(pending.sessionId);
    }
    if (seed && (pending.sessionReset || pending.role === 'error') && !current.pendingSeed) {
      fields.pendingSeed = seed;
    }
    if (pending.compact && final) {
      const compact = pending.compact as Record<string, unknown>;

      Object.assign(fields, EMPTY_WORKDIR_MEMORY, {
        pendingSeed: String(compact.seed || pending.reply || ''),
        compactedAt: Number(pending.at || Date.now()),
      });
      final.role = 'note';
      final.text = 'Контекст сжат';
    }
    if (pending.title && (!current.title || current.title === 'Новый чат'
      || current.title === userText.slice(0, 60))) {
      fields.title = String(pending.title);
    }
  }

  for (const message of messages) {
    if (turnId && message.turnId === turnId) {
      delete message.delivery;
      delete message.outbox;
      delete message.queued;
    }
  }

  return {
    ...fields,
    messages,
    ...(Array.isArray(current.outbox) ? {
      outbox: current.outbox.filter((entry: Record<string, unknown>) => entry.turnId !== turnId),
    } : {}),
    unread: !represented && final?.role === 'assistant' ? true : current.unread,
    updatedAt: Math.max(Number(current.updatedAt || 0), Number(pending.at || 0)),
  };
}
