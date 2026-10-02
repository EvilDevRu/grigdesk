import { decodeHistoryStepReuseRequest } from '../../../../shared/chatHistoryStepReuse.ts';
import type {
  HistoryStepReuseAck
} from '../../../../shared/chatHistoryStepReuse.ts';
import { messageKey } from '../../../../shared/chatMessageIdentity.ts';
import { ChatHistoryError } from './historyStore.ts';
import type {
  StoredChat
} from './historyStore.ts';

/**
 * Вызывается под lock чата до слияния: база и revision не могут смениться между проверкой и записью.
 * Копии сообщений получают прежние массивы, входной снимок и база остаются неизменными.
 */
export function restoreHistorySteps(
  incoming: StoredChat,
  base: StoredChat | null,
  value: unknown,
): StoredChat {
  const request = decodeHistoryStepReuseRequest(value, incoming.messages);

  if (!request) {
    throw new ChatHistoryError('bad_step_reuse', 'Повреждён запрос ссылок на шаги.', {
      statusCode: 400
    });
  }
  if (!base || request.baseRevision !== base.revision || incoming.revision !== base.revision) {
    throw new ChatHistoryError('chat_steps_changed', 'База сохранённых шагов изменилась.');
  }

  const messages = [...incoming.messages!];

  for (const ref of request.refs) {
    const source = base.messages?.[ref.sourceIndex];
    const destination = messages[ref.messageIndex] !;

    if (!source || messageKey(source) !== ref.expectedKey || messageKey(destination) !== ref.expectedKey ||
      !Array.isArray(source.steps) || source.steps.length !== ref.expectedLength) {
      throw new ChatHistoryError('chat_steps_changed', 'Сохранённая лента шагов больше не совпадает.');
    }

    messages[ref.messageIndex] = {
      ...destination,
      steps: source.steps
    };
  }

  return {
    ...incoming,
    messages
  };
}

/**
 * Подтверждение строится после canonical protection и durable write, либо доказанного no-op.
 * Совпадения длины недостаточно: изменённые тела той же длины не подтверждаются.
 */
export function historyStepReuseAck(incoming: StoredChat, saved: StoredChat): HistoryStepReuseAck {
  const confirmed: HistoryStepReuseAck['confirmed'] = [];

  for (const [messageIndex, message] of(incoming.messages || []).entries()) {
    const stored = saved.messages?.[messageIndex];

    if (!Array.isArray(message?.steps) || !stored || messageKey(message) !== messageKey(stored) ||
      !Array.isArray(stored.steps) || message.steps.length !== stored.steps.length) {
      continue;
    }
    if (message.steps !== stored.steps && JSON.stringify(message.steps) !== JSON.stringify(stored.steps)) {
      continue;
    }

    confirmed.push({
      messageIndex,
      sourceIndex: messageIndex,
      expectedKey: messageKey(stored),
      expectedLength: stored.steps.length,
    });
  }

  return {
    protocol: 1,
    revision: saved.revision!,
    confirmed
  };
}
